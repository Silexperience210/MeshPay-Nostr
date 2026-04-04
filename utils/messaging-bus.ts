/**
 * MessagingBus — Couche d'abstraction transport Nostr
 *
 * Principe de fonctionnement :
 *  • Nostr connecté → messages envoyés via Nostr (décentralisé, censure-résistant)
 *  • Nostr absent   → erreur explicite (plus de fallback MQTT)
 *
 * Bridge LoRa ↔ Nostr :
 *  • Un message LoRa/BLE entrant est republié sur Nostr si connecté
 *    → n'importe quel nœud Nostr avec internet peut le relayer
 *  • Un event kind:9001 (TxRelay) reçu de Nostr est injecté dans le flux BLE
 *
 * Format unifié BusMessage — valide pour Nostr et LoRa.
 */

import { nostrClient as defaultNostrClient, Kind, type NostrClient } from '@/utils/nostr-client';
import type { Event as NostrEvent } from 'nostr-tools';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MessageType = 'dm' | 'channel' | 'lora' | 'tx_relay';
export type Transport = 'nostr' | 'lora';

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

/** État de santé du transport Nostr */
export interface BusStatus {
  nostr: 'connected' | 'disconnected';
  /** Transport préféré actuellement utilisé pour l'envoi */
  preferred: 'nostr' | 'none';
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

// ─── Mapper Nostr → BusMessage ────────────────────────────────────────────────

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
  private nostr: NostrClient;
  private handlers = new Set<BusMessageHandler>();
  private dedup = new DeduplicateWindow();
  private nostrUnsubs: Array<() => void> = [];

  /** NodeId MESH-XXXX de l'utilisateur local (pour filtrer ses propres messages) */
  private localNodeId: string = '';
  /** Clé publique Nostr hex de l'utilisateur (pour s'abonner aux DMs entrants) */
  private localNostrPubkey: string = '';

  /** Ref pour les handlers à jour - évite le stale closure problem */
  private handlersRef: { current: Set<BusMessageHandler> } = { current: this.handlers };

  constructor(nostrClientInstance: NostrClient = defaultNostrClient) {
    this.nostr = nostrClientInstance;
    // Synchroniser la ref avec le Set réel
    this.handlersRef.current = this.handlers;
  }

  // ── Configuration ───────────────────────────────────────────────────────────

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

  get preferredTransport(): 'nostr' | 'none' {
    if (this.nostr.isConnected) return 'nostr';
    return 'none';
  }

  getStatus(): BusStatus {
    return {
      nostr: this.nostr.isConnected ? 'connected' : 'disconnected',
      preferred: this.preferredTransport,
    };
  }

  // ── Envoi ────────────────────────────────────────────────────────────────────

  /**
   * Envoie un DM via Nostr.
   * Publie un kind:4 avec tag meshcore-to pour le nodeId.
   */
  async sendDM(params: {
    toNodeId: string;
    toNostrPubkey: string;
    content: string;
  }): Promise<Transport> {
    const { toNostrPubkey, content } = params;

    if (this.nostr.isConnected) {
      // NIP-17 Gift Wrap (expéditeur masqué, chiffrement NIP-44) — fallback NIP-04 si nécessaire
      if (typeof this.nostr.publishDMSealed === 'function') {
        await this.nostr.publishDMSealed(toNostrPubkey, content);
      } else {
        await this.nostr.publishDM(toNostrPubkey, content);
      }
      return 'nostr';
    }

    throw new Error('[Bus] Aucun transport disponible pour l\'envoi DM');
  }

  /**
   * Envoie un message de channel via Nostr (kind:42 NIP-28).
   */
  async sendChannelMessage(params: {
    channelId: string;
    content: string;
    nostrChannelId?: string;
  }): Promise<Transport> {
    const { channelId, content, nostrChannelId } = params;

    if (this.nostr.isConnected) {
      const ncId = nostrChannelId ?? channelId;
      await this.nostr.publishChannelMessage(ncId, content);
      return 'nostr';
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
      type: 'lora_relay',
      data: rawPayload,
    });
    console.log('[Bus] Message LoRa bridgé vers Nostr (kind:9001)');
  }

  // ── Réception ────────────────────────────────────────────────────────────────

  /**
   * S'abonne aux messages Nostr.
   * Les messages dupliqués (même id) sont ignorés automatiquement.
   * Retourne une fonction de désabonnement.
   */
  subscribe(handler: BusMessageHandler): () => void {
    this.handlers.add(handler);
    // Mettre à jour la ref pour que les closures aient toujours la dernière version
    this.handlersRef.current = this.handlers;

    // Démarrer les listeners si c'est le premier subscriber
    if (this.handlers.size === 1) {
      this._startListeners();
    }

    return () => {
      this.handlers.delete(handler);
      // Mettre à jour la ref après suppression
      this.handlersRef.current = this.handlers;
      if (this.handlers.size === 0) {
        this._stopListeners();
      }
    };
  }

  // ── Listeners internes ───────────────────────────────────────────────────────

  private _startListeners(): void {
    this._startNostrListeners();
  }

  private _stopListeners(): void {
    for (const unsub of this.nostrUnsubs) {
      try { unsub(); } catch { /* ignore unsub errors */ }
    }
    this.nostrUnsubs = [];
  }

  /**
   * ✅ FIX: Méthode publique pour redémarrer les listeners Nostr.
   * Doit être appelé quand Nostr reconnecte (nouveau SimplePool = anciennes subs mortes).
   */
  restartListenersIfNeeded(): void {
    if (this.handlers.size === 0) return; // Personne n'écoute → rien à faire
    if (!this.localNostrPubkey) return;   // Pas d'identité → impossible

    console.log('[Bus] ♻ Restart listeners Nostr (reconnexion détectée)');
    this._stopListeners();
    this._startNostrListeners();
  }

  private _startNostrListeners(): void {
    if (!this.localNostrPubkey) return;

    // ✅ FIX: Stop existants d'abord pour éviter les doublons
    if (this.nostrUnsubs.length > 0) {
      this._stopListeners();
    }

    try {
      // DMs Nostr entrants NIP-04 (kind:4) — rétrocompatibilité
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
    } catch (err) {
      console.warn('[Bus] subscribeDMs NIP-04 échoué (keypair non prête ?):', err);
    }

    // DMs Nostr entrants NIP-17 sealed (kind:1059) — protocole principal
    // L'app envoie avec publishDMSealed(), on DOIT aussi écouter les sealed DMs entrants
    if (typeof this.nostr.subscribeDMsSealed === 'function') {
      try {
        const sealedUnsub = this.nostr.subscribeDMsSealed((from, content, event) => {
          if (from === this.localNostrPubkey) return; // ignorer nos propres copies
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
        this.nostrUnsubs.push(sealedUnsub);
        console.log('[Bus] Listeners Nostr démarrés (NIP-04 + NIP-17 sealed)');
      } catch (err) {
        console.warn('[Bus] subscribeDMsSealed NIP-17 échoué:', err);
        console.log('[Bus] Listeners Nostr démarrés (NIP-04 uniquement, NIP-17 échoué)');
      }
    } else {
      console.log('[Bus] Listeners Nostr démarrés (NIP-04 uniquement, NIP-17 indisponible)');
    }

    // TX Relay entrants (Bitcoin / Cashu / LoRa relay)
    try {
      const txUnsub = this.nostr.subscribeTxRelay((payload, event) => {
        // Les paquets LoRa relayés sont distingués par leur type et dispatchés en 'lora'
        const busType: BusMessage['type'] =
          payload.type === 'lora_relay' ? 'lora' : 'tx_relay';
        const bus: BusMessage = {
          id: event.id,
          type: busType,
          from: event.tags.find(t => t[0] === 'meshcore-from')?.[1] ?? event.pubkey,
          fromPubkey: event.pubkey,
          to: '',
          content: payload.type === 'lora_relay' ? payload.data : JSON.stringify(payload),
          ts: event.created_at * 1000,
          transport: 'nostr',
        };
        this._dispatch(bus);
      });
      this.nostrUnsubs.push(txUnsub);
    } catch (err) {
      console.warn('[Bus] subscribeTxRelay échoué:', err);
    }
  }

  /** Dispatch avec déduplication - utilise la ref pour éviter les stale handlers */
  private _dispatch(message: BusMessage): void {
    if (this.dedup.has(message.id)) {
      console.log('[Bus] Doublon ignoré (id:', message.id.slice(0, 12) + '…)');
      return;
    }
    this.dedup.add(message.id);

    // Utiliser la ref pour garantir l'accès aux handlers les plus récents
    const currentHandlers = this.handlersRef.current;
    for (const handler of currentHandlers) {
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
