/**
 * NostrAdapter - Bridge entre nostr-client et Hermès Engine
 * 
 * Transforme les événements Nostr (kind:4, kind:42, kind:9001) en événements
 * Hermès normalisés, et inversement.
 */

import { ProtocolAdapter, HermesEngine } from '../HermesEngine';
import { 
  Transport, 
  EventType, 
  HermesEvent, 
  MessageDirection,
  type MessageEvent,
} from '../types';
import type { Event as NostrEvent } from 'nostr-tools';

// Import du client Nostr existant (singleton)
import { nostrClient, Kind, type NostrClient } from '@/utils/nostr-client';
import { deriveNostrKeypair, type NostrKeypair } from '@/utils/nostr-client';

export interface NostrAdapterConfig {
  /** Auto-connect au démarrage */
  autoConnect: boolean;
  /** Relays par défaut */
  defaultRelays: string[];
  /** Timeout de connexion (ms) */
  connectTimeout: number;
}

export const DEFAULT_NOSTR_CONFIG: NostrAdapterConfig = {
  autoConnect: true,
  defaultRelays: [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
  ],
  connectTimeout: 10000,
};

export class NostrAdapter implements ProtocolAdapter {
  readonly name = Transport.NOSTR;
  private config: NostrAdapterConfig;
  private engine: HermesEngine;
  private nostr: NostrClient;
  private unsubs: Array<() => void> = [];
  private _pollingInterval: ReturnType<typeof setInterval> | undefined;
  private messageHandler?: (event: HermesEvent) => void;
  private _isConnected = false;
  private keypair: NostrKeypair | null = null;

  // Pour mapper les events Nostr → Hermès
  private eventIdMap = new Map<string, string>(); // nostrId → hermesId

  constructor(
    engine: HermesEngine,
    nostrClientInstance: NostrClient = nostrClient,
    config: Partial<NostrAdapterConfig> = {}
  ) {
    this.engine = engine;
    this.nostr = nostrClientInstance;
    this.config = { ...DEFAULT_NOSTR_CONFIG, ...config };
  }

  get isConnected(): boolean {
    return this._isConnected && this.nostr.isConnected;
  }

  // ─── Cycle de vie ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Guard contre double-start: clear l'intervalle précédent si présent
    if (this._pollingInterval !== undefined) {
      clearInterval(this._pollingInterval);
      this._pollingInterval = undefined;
    }

    // Écouter l'état de connexion Nostr
    const checkConnection = () => {
      const wasConnected = this._isConnected;
      this._isConnected = this.nostr.isConnected;

      if (!wasConnected && this._isConnected) {
        this.emitConnectionEvent(true);
        this.startListeners();
      } else if (wasConnected && !this._isConnected) {
        this.emitConnectionEvent(false);
        this.stopListeners();
      }
    };

    // Vérifier périodiquement (le nostrClient gère sa propre reconnexion)
    this._pollingInterval = setInterval(checkConnection, 1000);

    // Vérification initiale
    checkConnection();

    if (__DEV__) console.log('[NostrAdapter] Démarré');
  }

  async stop(): Promise<void> {
    if (this._pollingInterval !== undefined) {
      clearInterval(this._pollingInterval);
      this._pollingInterval = undefined;
    }
    this.stopListeners();
    for (const unsub of this.unsubs) {
      try { unsub(); } catch {}
    }
    this.unsubs = [];
    this._isConnected = false;
    console.log('[NostrAdapter] Arrêté');
  }

  // ─── Envoi ────────────────────────────────────────────────────────────────

  async send(event: HermesEvent): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Nostr non connecté');
    }

    switch (event.type) {
      case EventType.DM_SENT:
        await this.sendDM(event as MessageEvent);
        break;
      case EventType.CHANNEL_MSG_SENT:
        await this.sendChannelMessage(event as MessageEvent);
        break;
      case EventType.BRIDGE_LORA_TO_NOSTR:
        await this.sendTxRelay(event);
        break;
      default:
        console.warn('[NostrAdapter] Type non supporté pour envoi:', event.type);
    }
  }

  private async sendDM(event: MessageEvent): Promise<void> {
    const { to, payload } = event;
    
    // Le 'to' est un npub ou pubkey hex
    // Note: nostrClient.publishDMSealed gère le chiffrement
    try {
      const nostrEvent = await this.nostr.publishDMSealed(to, payload.content);
      // Mapper l'ID
      this.eventIdMap.set(nostrEvent.id, event.id);
      console.log('[NostrAdapter] DM envoyé:', nostrEvent.id);
    } catch (err) {
      console.error('[NostrAdapter] Échec envoi DM:', err);
      throw err;
    }
  }

  private async sendChannelMessage(event: MessageEvent): Promise<void> {
    const { payload } = event;
    const channelId = payload.channelName || 'general';
    
    try {
      const nostrEvent = await this.nostr.publishChannelMessage(
        channelId, 
        payload.content
      );
      this.eventIdMap.set(nostrEvent.id, event.id);
      console.log('[NostrAdapter] Message channel envoyé:', nostrEvent.id);
    } catch (err) {
      console.error('[NostrAdapter] Échec envoi channel:', err);
      throw err;
    }
  }

  private async sendTxRelay(event: HermesEvent): Promise<void> {
    // Pour le bridge LoRa → Nostr
    const payload = event.payload as Record<string, any> | undefined;
    try {
      await this.nostr.publishTxRelay({
        type: 'lora_relay',
        data: payload?.rawPayload || JSON.stringify(payload),
      });
      console.log('[NostrAdapter] TxRelay (bridge) envoyé');
    } catch (err) {
      console.error('[NostrAdapter] Échec bridge:', err);
      throw err;
    }
  }

  // ─── Réception ────────────────────────────────────────────────────────────

  onMessage(handler: (event: HermesEvent) => void): () => void {
    this.messageHandler = handler;
    return () => { this.messageHandler = undefined; };
  }

  private startListeners(): void {
    if (!this.nostr.isConnected) return;
    // Idempotent : ne pas redoubler les subscriptions existantes
    if (this.unsubs.length > 0) return;

    // DMs entrants (NIP-04 et NIP-17)
    try {
      const dmUnsub = this.nostr.subscribeDMsSealed((from, content, nostrEvent) => {
        this.handleIncomingDM(from, content, nostrEvent, 'nip44');
      });
      this.unsubs.push(dmUnsub);
    } catch (err) {
      // Fallback NIP-04
      console.warn('[NostrAdapter] NIP-17 non disponible, fallback NIP-04');
      try {
        const dmUnsub = this.nostr.subscribeDMs((from, content, nostrEvent) => {
          this.handleIncomingDM(from, content, nostrEvent, 'nip04');
        });
        this.unsubs.push(dmUnsub);
      } catch (err2) {
        console.error('[NostrAdapter] Impossible de souscrire aux DMs:', err2);
      }
    }

    // Messages de channel (NIP-28)
    try {
      const channelUnsub = this.nostr.subscribeChannel('*', (nostrEvent) => {
        this.handleIncomingChannel(nostrEvent);
      });
      this.unsubs.push(channelUnsub);
    } catch (err) {
      console.warn('[NostrAdapter] subscribeChannel échoué:', err);
    }

    // TX Relay (bridge, transactions, etc)
    try {
      const txUnsub = this.nostr.subscribeTxRelay((payload, nostrEvent) => {
        this.handleIncomingTxRelay(payload, nostrEvent);
      });
      this.unsubs.push(txUnsub);
    } catch (err) {
      console.warn('[NostrAdapter] subscribeTxRelay échoué:', err);
    }

    console.log('[NostrAdapter] Listeners démarrés');
  }

  private stopListeners(): void {
    for (const unsub of this.unsubs) {
      try { unsub(); } catch {}
    }
    this.unsubs = [];
    console.log('[NostrAdapter] Listeners arrêtés');
  }

  // ─── Handlers entrants ────────────────────────────────────────────────────

  private handleIncomingDM(
    from: string, 
    content: string, 
    nostrEvent: NostrEvent,
    encryption: 'nip04' | 'nip44'
  ): void {
    // Vérifier si c'est notre propre message (déduplication)
    if (from === this.nostr.publicKey) {
      return;
    }

    // Extraire nodeId depuis les tags si présent
    const meshcoreFrom = nostrEvent.tags.find(t => t[0] === 'meshcore-from')?.[1];
    const nodeId = meshcoreFrom || `npub-${from.slice(0, 8)}`;

    const event: MessageEvent = {
      id: this.generateHermesId(nostrEvent.id),
      type: EventType.DM_RECEIVED,
      transport: Transport.NOSTR,
      timestamp: nostrEvent.created_at * 1000,
      from: nodeId,
      to: 'local', // C'est pour nous
      payload: {
        content,
        contentType: 'text',
        encryption: encryption as MessageEvent['payload']['encryption'],
      },
      meta: {
        originalId: nostrEvent.id,
        protocolVersion: encryption,
      },
    };

    this.messageHandler?.(event);
  }

  private handleIncomingChannel(nostrEvent: NostrEvent): void {
    const channelId = nostrEvent.tags.find(t => t[0] === 'e')?.[1] || 'unknown';
    const meshcoreFrom = nostrEvent.tags.find(t => t[0] === 'meshcore-from')?.[1];
    
    const event: MessageEvent = {
      id: this.generateHermesId(nostrEvent.id),
      type: EventType.CHANNEL_MSG_RECEIVED,
      transport: Transport.NOSTR,
      timestamp: nostrEvent.created_at * 1000,
      from: meshcoreFrom || `npub-${nostrEvent.pubkey.slice(0, 8)}`,
      to: channelId,
      payload: {
        content: nostrEvent.content,
        contentType: 'text',
        channelName: channelId,
      },
      meta: {
        originalId: nostrEvent.id,
      },
    };

    this.messageHandler?.(event);
  }

  private handleIncomingTxRelay(payload: any, nostrEvent: NostrEvent): void {
    // Peut être un bridge LoRa ou une transaction Bitcoin
    const eventType = payload.type === 'lora_relay' 
      ? EventType.BRIDGE_NOSTR_TO_LORA
      : EventType.BRIDGE_NOSTR_TO_LORA;

    const event: HermesEvent = {
      id: this.generateHermesId(nostrEvent.id),
      type: eventType,
      transport: Transport.NOSTR,
      timestamp: nostrEvent.created_at * 1000,
      from: nostrEvent.pubkey,
      to: '*',
      payload: {
        originalTransport: Transport.NOSTR,
        targetTransport: Transport.LORA,
        rawPayload: payload.type === 'lora_relay' ? payload.data : JSON.stringify(payload),
        nostrPayload: payload,
      },
      meta: {
        originalId: nostrEvent.id,
      },
    };

    this.messageHandler?.(event);
  }

  // ─── Utilitaires ──────────────────────────────────────────────────────────

  private emitConnectionEvent(connected: boolean): void {
    const event: HermesEvent = {
      id: `nostr-${connected ? 'connected' : 'disconnected'}-${Date.now()}`,
      type: connected 
        ? EventType.TRANSPORT_CONNECTED 
        : EventType.TRANSPORT_DISCONNECTED,
      transport: Transport.NOSTR,
      timestamp: Date.now(),
      from: 'nostr',
      to: '*',
      payload: {
        transport: Transport.NOSTR,
        endpoint: (this.nostr as any).relays?.map((r: any) => r.url).join(', ') || 'unknown',
      },
      meta: {},
    };
    this.messageHandler?.(event);
  }

  private generateHermesId(nostrId: string): string {
    // Utiliser l'ID Nostr comme base pour la déduplication
    return `nostr-${nostrId}`;
  }

  // ─── API Publique Spécifique ──────────────────────────────────────────────

  /** Reconnecter aux relays */
  async reconnect(): Promise<void> {
    if (typeof (this.nostr as any).reconnectRelays === 'function') {
      await (this.nostr as any).reconnectRelays();
    }
  }

  /** Publier un event générique */
  async publish(template: { kind: number; content: string; tags: string[][] }): Promise<NostrEvent> {
    return this.nostr.publish({ ...template, created_at: Math.floor(Date.now() / 1000) });
  }
}
