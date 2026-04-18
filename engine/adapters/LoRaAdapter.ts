/**
 * LoRaAdapter - Bridge entre BLE/LoRa et Hermès Engine
 * 
 * Transforme les paquets MeshCore binaires en événements Hermès.
 * Gère aussi le bridge LoRa → Nostr automatique si configuré.
 */

import { ProtocolAdapter, HermesEngine } from '../HermesEngine';
import { 
  Transport, 
  EventType, 
  HermesEvent,
  MessageEvent,
  BridgeEvent,
} from '../types';

// Imports existants
import { 
  getBleGatewayClient, 
  BleGatewayClient,
  type MeshCoreIncomingMsg,
  type MeshCoreContact,
} from '@/utils/ble-gateway';
import { 
  extractTextFromPacket,
  decodeMeshCorePacket,
  isChunkPacket,
  MeshCoreMessageType,
} from '@/utils/meshcore-protocol';

export interface LoRaAdapterConfig {
  /** Auto-connect au gateway BLE connu */
  autoConnect: boolean;
  /** Bridge automatique LoRa → Nostr */
  autoBridgeToNostr: boolean;
  /** Device ID du dernier gateway connecté */
  lastDeviceId?: string;
}

export const DEFAULT_LORA_CONFIG: LoRaAdapterConfig = {
  autoConnect: false,
  autoBridgeToNostr: true,
};

export class LoRaAdapter implements ProtocolAdapter {
  readonly name = Transport.LORA;
  private config: LoRaAdapterConfig;
  private engine: HermesEngine;
  private bleClient: BleGatewayClient;
  private messageHandler?: (event: HermesEvent) => void;
  private _isConnected = false;
  private unsubCallbacks: Array<() => void> = [];
  private _bridgeCounter = 0;
  private _msgIdCounter = 0;
  
  // Gestion des contacts connus
  private contacts = new Map<string, MeshCoreContact>();

  // Pour le chunking (msgId → { text accumulé, timestamp pour TTL })
  private partialMessages = new Map<string, { text: string; firstSeenMs: number }>();
  private static readonly PARTIAL_TTL_MS = 60_000;
  private partialSweepTimer: ReturnType<typeof setInterval> | null = null;

  // Déduplication des messages reçus (par msgId)
  private recentMsgIds = new Map<string, number>(); // msgId → expiresAt
  private static readonly DEDUP_TTL_MS = 5 * 60_000;
  private static readonly DEDUP_MAX = 1000;

  private _listenersSetup = false;

  constructor(
    engine: HermesEngine,
    bleClientInstance: BleGatewayClient = getBleGatewayClient(),
    config: Partial<LoRaAdapterConfig> = {}
  ) {
    this.engine = engine;
    this.bleClient = bleClientInstance;
    this.config = { ...DEFAULT_LORA_CONFIG, ...config };
  }

  get isConnected(): boolean {
    return this._isConnected && this.bleClient.isConnected();
  }

  // ─── Cycle de vie ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Écouter l'état de connexion BLE
    this.bleClient.onDisconnect(() => {
      if (this._isConnected) {
        this._isConnected = false;
        this.emitConnectionEvent(false);
      }
    });

    // Purge périodique des partial messages expirés
    if (!this.partialSweepTimer) {
      this.partialSweepTimer = setInterval(() => this.sweepExpired(), 30_000);
    }

    // Auto-connect si configuré
    if (this.config.autoConnect && this.config.lastDeviceId) {
      try {
        await this.connect(this.config.lastDeviceId);
      } catch (err) {
        if (__DEV__) console.log('[LoRaAdapter] Auto-connect échoué:', err);
      }
    }

    if (__DEV__) console.log('[LoRaAdapter] Démarré');
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubCallbacks) {
      try { unsub(); } catch {}
    }
    this.unsubCallbacks = [];
    this._listenersSetup = false;

    if (this.partialSweepTimer) {
      clearInterval(this.partialSweepTimer);
      this.partialSweepTimer = null;
    }
    this.partialMessages.clear();
    this.recentMsgIds.clear();

    if (this._isConnected) {
      await this.bleClient.disconnect().catch(() => { /* cleanup: ignore */ });
      this._isConnected = false;
    }

    if (__DEV__) console.log('[LoRaAdapter] Arrêté');
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, meta] of this.partialMessages) {
      if (now - meta.firstSeenMs > LoRaAdapter.PARTIAL_TTL_MS) {
        this.partialMessages.delete(id);
      }
    }
    for (const [id, expiresAt] of this.recentMsgIds) {
      if (now > expiresAt) this.recentMsgIds.delete(id);
    }
  }

  // ─── Connexion ────────────────────────────────────────────────────────────

  async connect(deviceId: string): Promise<void> {
    await this.bleClient.connect(deviceId);
    this._isConnected = true;
    this.config.lastDeviceId = deviceId;
    
    // Configurer les listeners
    this.setupListeners();
    
    this.emitConnectionEvent(true);
    console.log('[LoRaAdapter] Connecté à:', deviceId);
  }

  async disconnect(): Promise<void> {
    await this.bleClient.disconnect();
    this._isConnected = false;
    this.emitConnectionEvent(false);
  }

  private setupListeners(): void {
    if (this._listenersSetup) return;
    this._listenersSetup = true;

    this.bleClient.onIncomingMessage((msg) => {
      this.handleIncomingMessage(msg);
    });

    this.bleClient.onContactDiscovered((contact) => {
      this.contacts.set(contact.pubkeyHex, contact);
    });

    this.bleClient.onContacts((contacts) => {
      for (const c of contacts) {
        this.contacts.set(c.pubkeyHex, c);
      }
    });

    this.unsubCallbacks.push(() => {
      this.bleClient.onIncomingMessage(() => {});
      this.bleClient.onContactDiscovered(() => {});
      this.bleClient.onContacts(() => {});
    });
  }

  // ─── Envoi ────────────────────────────────────────────────────────────────

  async send(event: HermesEvent): Promise<void> {
    if (!this.isConnected) {
      throw new Error('LoRa non connecté');
    }

    switch (event.type) {
      case EventType.DM_SENT:
        await this.sendDM(event as MessageEvent);
        break;
      case EventType.CHANNEL_MSG_SENT:
        await this.sendChannelMessage(event as MessageEvent);
        break;
      case EventType.BRIDGE_NOSTR_TO_LORA:
        await this.forwardBridgeToLora(event as BridgeEvent);
        break;
      default:
        console.warn('[LoRaAdapter] Type non supporté:', event.type);
    }
  }

  private async sendDM(event: MessageEvent): Promise<void> {
    const { to, payload } = event;
    
    // 'to' est un nodeId ou pubkeyHex
    // Trouver le contact
    let contact: MeshCoreContact | undefined;
    
    // Recherche par pubkey
    contact = this.contacts.get(to);
    
    if (!contact) {
      throw new Error(`Contact ${to} non trouvé pour envoi LoRa`);
    }

    try {
      await this.bleClient.sendDirectMessage(contact.pubkeyHex, payload.content);
      console.log('[LoRaAdapter] DM envoyé via LoRa à:', contact.pubkeyHex.slice(0, 16));
    } catch (err) {
      console.error('[LoRaAdapter] Échec envoi DM LoRa:', err);
      throw err;
    }
  }

  private async forwardBridgeToLora(event: BridgeEvent): Promise<void> {
    const { payload } = event;
    let target: string;
    let content: string;
    try {
      const parsed = JSON.parse(payload.rawPayload || '{}');
      target = parsed.target || event.from;
      content = parsed.content || '';
    } catch {
      target = event.from;
      content = String(payload.rawPayload || '');
    }

    const contact = this.contacts.get(target);
    if (!contact) {
      throw new Error(`Contact ${target} non trouvé pour bridge LoRa`);
    }
    await this.bleClient.sendDirectMessage(contact.pubkeyHex, content);
  }

  private async sendChannelMessage(event: MessageEvent): Promise<void> {
    const { payload } = event;
    const channelMatch = payload.channelName?.match(/channel-(\d+)/);
    const channelIdx = channelMatch ? parseInt(channelMatch[1], 10) : 0;

    try {
      await this.bleClient.sendChannelMessage(channelIdx, payload.content);
      console.log('[LoRaAdapter] Message channel envoyé via LoRa');
    } catch (err) {
      console.error('[LoRaAdapter] Échec envoi channel LoRa:', err);
      throw err;
    }
  }

  // ─── Réception ────────────────────────────────────────────────────────────

  onMessage(handler: (event: HermesEvent) => void): () => void {
    this.messageHandler = handler;
    return () => { this.messageHandler = undefined; };
  }

  private handleIncomingMessage(msg: MeshCoreIncomingMsg): void {
    if (__DEV__) console.log('[LoRaAdapter] Message reçu:', msg.type, 'de', msg.senderPubkeyPrefix?.slice(0, 16));

    // Dédup : ignorer les retransmissions du même msgId
    const originalId = (msg as any).msgId ? String((msg as any).msgId) : undefined;
    if (originalId) {
      const now = Date.now();
      if (this.recentMsgIds.has(originalId)) return;
      if (this.recentMsgIds.size >= LoRaAdapter.DEDUP_MAX) {
        const firstKey = this.recentMsgIds.keys().next().value;
        if (firstKey) this.recentMsgIds.delete(firstKey);
      }
      this.recentMsgIds.set(originalId, now + LoRaAdapter.DEDUP_TTL_MS);
    }

    // Déterminer le type d'événement
    let eventType: EventType;
    let content: string;
    let channelName: string | undefined;

    switch (msg.type) {
      case 'direct':
        eventType = EventType.DM_RECEIVED;
        content = msg.text || '';
        break;
      case 'channel':
        eventType = EventType.CHANNEL_MSG_RECEIVED;
        content = msg.text || '';
        channelName = `channel-${msg.channelIdx || 0}`;
        break;
      default:
        // Traitement spécial pour les types inconnus (ex: announce)
        if ((msg as any).type === 'announce') {
          this.handleAnnounce(msg);
          return;
        }
        console.warn('[LoRaAdapter] Type de message inconnu:', msg.type);
        return;
    }

    // Créer l'événement Hermès
    const event: MessageEvent = {
      id: this.generateHermesId(msg),
      type: eventType,
      transport: Transport.LORA,
      timestamp: msg.timestamp || Date.now(),
      from: msg.senderPubkeyPrefix || 'unknown',
      to: msg.type === 'direct' ? 'local' : (channelName || 'broadcast'),
      payload: {
        content,
        contentType: this.detectContentType(content),
        channelName,
      },
      meta: {
        originalId: (msg as any).msgId,
        hops: msg.pathLen,
        snr: msg.snr,
      },
    };

    this.messageHandler?.(event);

    // Bridge automatique vers Nostr si activé
    if (this.config.autoBridgeToNostr) {
      this.bridgeToNostr(event);
    }
  }

  private handleAnnounce(msg: MeshCoreIncomingMsg): void {
    // Extraire les infos de l'announce
    const event: HermesEvent = {
      id: `lora-announce-${Date.now()}`,
      type: EventType.SYSTEM_READY, // Ou un type spécifique
      transport: Transport.LORA,
      timestamp: Date.now(),
      from: msg.senderPubkeyPrefix || 'unknown',
      to: '*',
      payload: {
        type: 'announce',
        nodeId: msg.senderPubkeyPrefix,
      },
      meta: {},
    };

    this.messageHandler?.(event);
  }

  private bridgeToNostr(loraEvent: MessageEvent): void {
    const bridgeEvent: BridgeEvent = {
      id: `bridge-${loraEvent.id}-${++this._bridgeCounter}`,
      type: EventType.BRIDGE_LORA_TO_NOSTR,
      transport: Transport.INTERNAL,
      timestamp: Date.now(),
      from: loraEvent.from,
      to: '*',
      payload: {
        originalTransport: Transport.LORA,
        targetTransport: Transport.NOSTR,
        rawPayload: JSON.stringify(`${loraEvent.from}:${loraEvent.payload.content}`),
      },
      meta: {
        originalId: loraEvent.id,
      },
    };

    // Dispatch locally for subscribers
    this.messageHandler?.(bridgeEvent);

    // Route to NostrAdapter.send() if available
    const nostrAdapter = this.engine.getAdapter(Transport.NOSTR);
    if (nostrAdapter?.isConnected) {
      nostrAdapter.send(bridgeEvent).catch(err =>
        console.warn('[LoRaAdapter] Bridge to Nostr failed:', err)
      );
    }

    console.log('[LoRaAdapter] Bridged vers Nostr:', loraEvent.id);
  }

  // ─── Utilitaires ──────────────────────────────────────────────────────────

  private detectContentType(content: string): string {
    if (content.startsWith('cashu')) return 'cashu';
    if (content.startsWith('data:image')) return 'image';
    if (content.startsWith('data:audio')) return 'audio';
    try {
      const parsed = JSON.parse(content);
      if (parsed.type) return parsed.type;
    } catch {}
    return 'text';
  }

  private generateHermesId(msg: MeshCoreIncomingMsg): string {
    return `lora-${msg.senderPubkeyPrefix?.slice(0, 16)}-${(msg as any).msgId || `${Date.now()}-${++this._msgIdCounter}`}`;
  }

  private emitConnectionEvent(connected: boolean): void {
    const event: HermesEvent = {
      id: `lora-${connected ? 'connected' : 'disconnected'}-${Date.now()}`,
      type: connected 
        ? EventType.TRANSPORT_CONNECTED 
        : EventType.TRANSPORT_DISCONNECTED,
      transport: Transport.LORA,
      timestamp: Date.now(),
      from: 'lora',
      to: '*',
      payload: {
        transport: Transport.LORA,
        endpoint: this.config.lastDeviceId || 'unknown',
      },
      meta: {},
    };
    this.messageHandler?.(event);
  }

  // ─── API Publique Spécifique ──────────────────────────────────────────────

  getContacts(): MeshCoreContact[] {
    return Array.from(this.contacts.values());
  }

  async syncContacts(): Promise<void> {
    await this.bleClient.syncNextMessage();
  }

  async setChannel(channelIdx: number, name: string, secret: Uint8Array): Promise<void> {
    await this.bleClient.setChannel(channelIdx, name, secret);
  }

  getDeviceInfo() {
    return this.bleClient.getDeviceInfo();
  }
}
