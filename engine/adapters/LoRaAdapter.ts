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
  
  // Gestion des contacts connus
  private contacts = new Map<string, MeshCoreContact>();
  
  // Pour le chunking
  private partialMessages = new Map<string, string>(); // msgId → accumulatedText

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
    return this._isConnected && this.bleClient.isConnected;
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

    // Auto-connect si configuré
    if (this.config.autoConnect && this.config.lastDeviceId) {
      try {
        await this.connect(this.config.lastDeviceId);
      } catch (err) {
        console.log('[LoRaAdapter] Auto-connect échoué:', err);
      }
    }

    console.log('[LoRaAdapter] Démarré');
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubCallbacks) {
      try { unsub(); } catch {}
    }
    this.unsubCallbacks = [];
    
    if (this._isConnected) {
      await this.bleClient.disconnect().catch(() => {});
      this._isConnected = false;
    }
    
    console.log('[LoRaAdapter] Arrêté');
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
    // Messages entrants via LoRa
    this.bleClient.onIncomingMessage((msg) => {
      this.handleIncomingMessage(msg);
    });

    // Contacts découverts
    this.bleClient.onContactDiscovered((contact) => {
      this.contacts.set(contact.pubkeyHex, contact);
    });

    // Liste complète des contacts
    this.bleClient.onContacts((contacts) => {
      for (const c of contacts) {
        this.contacts.set(c.pubkeyHex, c);
      }
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

  private async sendChannelMessage(event: MessageEvent): Promise<void> {
    const { payload } = event;
    
    try {
      await this.bleClient.sendChannelMessage(payload.content);
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
    console.log('[LoRaAdapter] Message reçu:', msg.type, 'de', msg.senderPubkey?.slice(0, 16));

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
        channelName = `channel-${msg.channel || 0}`;
        break;
      case 'announce':
        // Traitement spécial pour les announces
        this.handleAnnounce(msg);
        return;
      default:
        console.warn('[LoRaAdapter] Type de message inconnu:', msg.type);
        return;
    }

    // Créer l'événement Hermès
    const event: MessageEvent = {
      id: this.generateHermesId(msg),
      type: eventType,
      transport: Transport.LORA,
      timestamp: msg.receivedAt || Date.now(),
      from: msg.senderPubkey || 'unknown',
      fromPubkey: msg.senderPubkey || 'unknown',
      to: msg.type === 'direct' ? 'local' : (channelName || 'broadcast'),
      payload: {
        content,
        contentType: this.detectContentType(content),
        channelName,
      },
      meta: {
        originalId: msg.msgId,
        rttMs: msg.rttMs,
        hops: msg.hops,
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
      from: msg.senderPubkey || 'unknown',
      to: '*',
      payload: {
        type: 'announce',
        nodeId: msg.senderPubkey,
      },
      meta: {},
    };

    this.messageHandler?.(event);
  }

  private bridgeToNostr(loraEvent: MessageEvent): void {
    // Créer un événement de bridge
    const bridgeEvent: BridgeEvent = {
      id: `bridge-${loraEvent.id}`,
      type: EventType.BRIDGE_LORA_TO_NOSTR,
      transport: Transport.LORA,
      timestamp: Date.now(),
      from: loraEvent.from,
      to: '*',
      payload: {
        originalTransport: Transport.LORA,
        targetTransport: Transport.NOSTR,
        rawPayload: JSON.stringify(loraEvent.payload),
      },
      meta: {
        originalId: loraEvent.id,
      },
    };

    // Émettre dans Hermès - le NostrAdapter s'en chargera
    this.messageHandler?.(bridgeEvent);
    
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
    // Combiner plusieurs champs pour un ID unique stable
    return `lora-${msg.senderPubkey?.slice(0, 16)}-${msg.msgId || Date.now()}`;
  }

  private emitConnectionEvent(connected: boolean): void {
    const event: HermesEvent = {
      id: `lora-conn-${Date.now()}`,
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
    await this.bleClient.syncContacts();
  }

  async setChannel(channelIdx: number): Promise<void> {
    await this.bleClient.setChannel(channelIdx);
  }

  getDeviceInfo() {
    return this.bleClient.getDeviceInfo();
  }
}
