/**
 * MessagingBus — Couche d'abstraction transport MQTT / Nostr
 *
 * Principe de fonctionnement :
 *  • Nostr connecté → messages envoyés via Nostr (décentralisé, censure-résistant)
 *  • Nostr absent   → fallback MQTT (existant, inchangé)
 *  • Les deux sont écoutés simultanément → messages dédupliqués par ID
 *
 * Bridge LoRa ↔ Nostr :
 *  • Un message LoRa/BLE entrant est republié sur Nostr si connecté
 *    → n'importe quel nœud Nostr avec internet peut le relayer
 *  • Un event kind:9001 (TxRelay) reçu de Nostr est injecté dans le flux BLE
 *
 * Format unifié BusMessage — valide pour MQTT et Nostr.
 */

import { TOPICS, type MeshMqttClient, publishMesh, subscribeMesh, unsubscribeMesh } from '@/utils/mqtt-client';
import { nostrClient as defaultNostrClient, Kind, type NostrClient } from '@/utils/nostr-client';
import type { Event as NostrEvent } from 'nostr-tools';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MessageType = 'dm' | 'channel' | 'lora' | 'tx_relay';
export type Transport = 'nostr' | 'mqtt' | 'lora';

/**
 * Format unifié, indépendant du transport utilisé.
 */
export interface BusMessage {
  /** UUID unique — sert à la déduplication multi-transport */
  id: string;
  type: MessageType;
  /** NodeId MESH-XXXX ou npub1… de l'émetteur */
  from: string;
  /** Clé publique hex 33-bytes de l'émetteur (pour chiffrement réponse) */
  fromPubkey: string;
  /** NodeId ou channelId du destinataire */
  to: string;
  /** Contenu en clair (après déchiffrement) */
  content: string;
  /** Timestamp Unix millisecondes */
  ts: number;
  /** Transport source — pour affichage/debug */
  transport: Transport;
}

export type BusMessageHandler = (message: BusMessage) => void;

/** État de santé des deux transports */
export interface BusStatus {
  nostr: 'connected' | 'disconnected';
  mqtt: 'connected' | 'disconnected' | 'connecting' | 'error';
  /** Transport préféré actuellement utilisé pour l'envoi */
  preferred: 'nostr' | 'mqtt' | 'none';
}

// ─── Déduplication ────────────────────────────────────────────────────────────

const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEDUP_MAX = 1000;

class DeduplicateWindow {
  private seen = new Map<string, number>(); // id → timestamp

  has(id: string): boolean {
    this._cleanup();
    return this.seen.has(id);
  }

  add(id: string): void {
    this._cleanup();
    if (this.seen.size >= DEDUP_MAX) {
      // Supprimer le plus ancien si la fenêtre est pleine
      const oldest = [...this.seen.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.seen.delete(oldest[0]);
    }
    this.seen.set(id, Date.now());
  }

  private _cleanup(): void {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }

  get size(): number { return this.seen.size; }
}

// ─── Mappers MQTT ↔ BusMessage ────────────────────────────────────────────────

/**
 * Parse un payload MQTT (WireMessage JSON) en BusMessage.
 * Retourne null si le payload n'est pas un WireMessage valide.
 */
function mqttPayloadToBus(
  topic: string,
  payload: string,
): BusMessage | null {
  try {
    const wire = JSON.parse(payload) as Record<string, unknown>;

    // WireMessage minimum : id, from, content/enc, ts
    if (!wire.id || typeof wire.id !== 'string') return null;

    const type: MessageType = topic.includes('/forum/') ? 'channel'
      : topic.includes('/lora/') ? 'lora'
      : topic.includes('/tx/') || topic.includes('/cashu/') ? 'tx_relay'
      : 'dm';

    return {
      id: wire.id as string,
      type,
      from: (wire.fromNodeId as string) ?? (wire.from as string) ?? 'unknown',
      fromPubkey: (wire.fromPubkey as string) ?? '',
      to: (wire.to as string) ?? '',
      content: (wire.enc as string) ?? (wire.content as string) ?? '',
      ts: typeof wire.ts === 'number' ? wire.ts : Date.now(),
      transport: 'mqtt',
    };
  } catch {
    return null;
  }
}

/**
 * Parse un NostrEvent en BusMessage.
 * Retourne null si l'event n'est pas géré par le bus.
 */
function nostrEventToBus(event: NostrEvent): BusMessage | null {
  try {
    const type: MessageType =
      event.kind === Kind.EncryptedDM ? 'dm'
      : event.kind === Kind.ChannelMessage ? 'channel'
      : event.kind === Kind.TxRelay ? 'tx_relay'
      : null as never;

    if (!type) return null;

    // ID de déduplication = event.id Nostr (globalement unique)
    // nodeId MeshCore transmis dans les tags ['meshcore-from', nodeId]
    const meshcoreFrom = event.tags.find(t => t[0] === 'meshcore-from')?.[1] ?? event.pubkey;
    const meshcoreTo = event.tags.find(t => t[0] === 'meshcore-to')?.[1]
      ?? event.tags.find(t => t[0] === 'e')?.[1]
      ?? '';

    return {
      id: event.id,
      type,
      from: meshcoreFrom,
      fromPubkey: event.pubkey,
      to: meshcoreTo,
      content: event.content, // NIP-04 : encore chiffré → déchiffrement en amont (NostrClient)
      ts: event.created_at * 1000,
      transport: 'nostr',
    };
  } catch {
    return null;
  }
}

// ─── MessagingBus ─────────────────────────────────────────────────────────────

export class MessagingBus {
  private mqtt: MeshMqttClient | null = null;
  private nostr: NostrClient;
  private handlers = new Set<BusMessageHandler>();
  private dedup = new DeduplicateWindow();
  private mqttUnsubs: Array<() => void> = [];
  private nostrUnsubs: Array<() => void> = [];

  /** NodeId MESH-XXXX de l'utilisateur local (pour filtrer ses propres messages) */
  private localNodeId: string = '';
  /** Clé publique Nostr hex de l'utilisateur (pour s'abonner aux DMs entrants) */
  private localNostrPubkey: string = '';

  constructor(nostrClientInstance: NostrClient = defaultNostrClient) {
    this.nostr = nostrClientInstance;
  }

  // ── Configuration ───────────────────────────────────────────────────────────

  setMqtt(instance: MeshMqttClient): void {
    this.mqtt = instance;
  }

  setLocalIdentity(nodeId: string, nostrPubkey: string): void {
    this.localNodeId = nodeId;
    this.localNostrPubkey = nostrPubkey;

    // Si des subscribers actifs et Nostr listeners pas encore démarrés
    // (identité arrivée après la première subscription) → les démarrer maintenant
    if (this.handlers.size > 0 && this.nostrUnsubs.length === 0) {
      console.log('[Bus] Identité arrivée tardive — démarrage des listeners Nostr');
      this._startNostrListeners();
    }
  }

  // ── Transport routing ────────────────────────────────────────────────────────

  get preferredTransport(): 'nostr' | 'mqtt' | 'none' {
    if (this.nostr.isConnected) return 'nostr';
    if (this.mqtt?.state === 'connected') return 'mqtt';
    return 'none';
  }

  getStatus(): BusStatus {
    return {
      nostr: this.nostr.isConnected ? 'connected' : 'disconnected',
      mqtt: this.mqtt?.state ?? 'disconnected',
      preferred: this.preferredTransport,
    };
  }

  // ── Envoi ────────────────────────────────────────────────────────────────────

  /**
   * Envoie un DM au transport préféré.
   * Si Nostr : publie un kind:4 avec tag meshcore-to pour le nodeId.
   * Si MQTT  : publie sur meshcore/dm/{toNodeId} (comportement existant inchangé).
   */
  async sendDM(params: {
    toNodeId: string;
    toNostrPubkey: string;
    content: string;
    encryptedPayload?: string; // WireMessage déjà chiffré (existant)
  }): Promise<Transport> {
    const { toNodeId, toNostrPubkey, content, encryptedPayload } = params;

    if (this.preferredTransport === 'nostr') {
      // publishDM gère le NIP-04 (chiffrement + tag ['p', recipientPubkey])
      await this.nostr.publishDM(toNostrPubkey, content);
      return 'nostr';
    }

    if (this.mqtt?.state === 'connected' && encryptedPayload) {
      publishMesh(this.mqtt, TOPICS.dm(toNodeId), encryptedPayload);
      return 'mqtt';
    }

    throw new Error('[Bus] Aucun transport disponible pour l\'envoi DM');
  }

  /**
   * Envoie un message de channel.
   * Nostr → kind:42 (NIP-28) ; MQTT → meshcore/forum/{channelId}.
   */
  async sendChannelMessage(params: {
    channelId: string;
    content: string;
    nostrChannelId?: string;  // Event ID de création du channel NIP-28
    encryptedPayload?: string;
  }): Promise<Transport> {
    const { channelId, content, nostrChannelId, encryptedPayload } = params;

    if (this.preferredTransport === 'nostr') {
      const ncId = nostrChannelId ?? channelId;
      await this.nostr.publishChannelMessage(ncId, content);
      return 'nostr';
    }

    if (this.mqtt?.state === 'connected' && encryptedPayload) {
      publishMesh(this.mqtt, TOPICS.forum(channelId), encryptedPayload);
      return 'mqtt';
    }

    throw new Error('[Bus] Aucun transport disponible pour le message de channel');
  }

  /**
   * Bridge LoRa → Nostr.
   * Un message LoRa brut est republié sur Nostr (kind:9001) pour qu'un
   * nœud gateway internet puisse le recevoir et le traiter.
   */
  async bridgeLoraToNostr(rawPayload: string): Promise<void> {
    if (!this.nostr.isConnected) return;
    await this.nostr.publishTxRelay({
      type: 'bitcoin_tx', // sera précisé par le parseur aval
      data: rawPayload,
    });
    console.log('[Bus] Message LoRa bridgé vers Nostr (kind:9001)');
  }

  // ── Réception ────────────────────────────────────────────────────────────────

  /**
   * S'abonne aux messages des deux transports.
   * Les messages dupliqués (même id) sont ignorés automatiquement.
   * Retourne une fonction de désabonnement.
   */
  subscribe(handler: BusMessageHandler): () => void {
    this.handlers.add(handler);

    // Démarrer les listeners si c'est le premier subscriber
    if (this.handlers.size === 1) {
      this._startListeners();
    }

    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) {
        this._stopListeners();
      }
    };
  }

  // ── Listeners internes ───────────────────────────────────────────────────────

  private _startListeners(): void {
    this._startMqttListeners();
    this._startNostrListeners();
  }

  private _stopListeners(): void {
    for (const unsub of this.mqttUnsubs) unsub();
    for (const unsub of this.nostrUnsubs) unsub();
    this.mqttUnsubs = [];
    this.nostrUnsubs = [];
  }

  private _startMqttListeners(): void {
    if (!this.mqtt || !this.localNodeId) return;

    // DMs entrants
    const dmHandler = (topic: string, payload: string) => {
      const msg = mqttPayloadToBus(topic, payload);
      if (msg) this._dispatch(msg);
    };
    subscribeMesh(this.mqtt, TOPICS.dm(this.localNodeId), dmHandler);
    this.mqttUnsubs.push(() => unsubscribeMesh(this.mqtt!, TOPICS.dm(this.localNodeId)));

    // LoRa inbound
    const loraHandler = (topic: string, payload: string) => {
      const msg = mqttPayloadToBus(topic, payload);
      if (msg) {
        // Bridge LoRa → Nostr (best effort)
        this.bridgeLoraToNostr(payload).catch(() => {});
        this._dispatch(msg);
      }
    };
    subscribeMesh(this.mqtt, TOPICS.loraInbound, loraHandler, 0);
    this.mqttUnsubs.push(() => unsubscribeMesh(this.mqtt!, TOPICS.loraInbound));
  }

  private _startNostrListeners(): void {
    if (!this.localNostrPubkey) return;

    // DMs Nostr entrants (déchiffrés automatiquement par NostrClient)
    const dmUnsub = this.nostr.subscribeDMs((from, content, event) => {
      if (from === this.localNostrPubkey) return; // ignorer nos propres DMs
      const bus: BusMessage = {
        id: event.id,
        type: 'dm',
        from: event.tags.find(t => t[0] === 'meshcore-from')?.[1] ?? from,
        fromPubkey: from,
        to: this.localNodeId,
        content,
        ts: event.created_at * 1000,
        transport: 'nostr',
      };
      this._dispatch(bus);
    });
    this.nostrUnsubs.push(dmUnsub);

    // TX Relay entrants (Bitcoin / Cashu)
    const txUnsub = this.nostr.subscribeTxRelay((payload, event) => {
      const bus: BusMessage = {
        id: event.id,
        type: 'tx_relay',
        from: event.tags.find(t => t[0] === 'meshcore-from')?.[1] ?? event.pubkey,
        fromPubkey: event.pubkey,
        to: '',
        content: JSON.stringify(payload),
        ts: event.created_at * 1000,
        transport: 'nostr',
      };
      this._dispatch(bus);
    });
    this.nostrUnsubs.push(txUnsub);
  }

  /** Dispatch avec déduplication */
  private _dispatch(message: BusMessage): void {
    if (this.dedup.has(message.id)) {
      console.log('[Bus] Doublon ignoré (id:', message.id.slice(0, 12) + '…)');
      return;
    }
    this.dedup.add(message.id);

    for (const handler of this.handlers) {
      try {
        handler(message);
      } catch (err) {
        console.error('[Bus] Erreur dans handler:', err);
      }
    }
  }

  /** Taille de la fenêtre de déduplication (pour monitoring) */
  get dedupSize(): number {
    return this.dedup.size;
  }
}

// ─── Singleton app-wide ───────────────────────────────────────────────────────
export const messagingBus = new MessagingBus();
