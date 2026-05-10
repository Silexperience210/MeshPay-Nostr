/**
 * TX Relay — Relay de transactions Bitcoin et tokens Cashu via Nostr (kind:9001)
 *
 * Architecture :
 *
 *   Appareil OFFLINE (LoRa/BLE)
 *     → signe une TX Bitcoin ou crée un token Cashu
 *     → publie kind:9001 { type: 'bitcoin_tx'|'cashu_token', data }
 *     → attend une confirmation kind:9001 { type: 'relay_result', ['e', requestId] }
 *
 *   Gateway (appareil avec internet + Nostr connecté)
 *     → écoute les kind:9001 depuis les 5 dernières minutes
 *     → broadcast la TX sur mempool.space ou confirme le token Cashu
 *     → publie la confirmation kind:9001 avec ['e', originalId]
 *
 * Idempotence :
 *   - Le gateway déduplique par event.id (ne traite pas deux fois le même relay)
 *   - mempool.space retourne une erreur connue si la TX est déjà broadcast (ignoré)
 *
 * Sécurité :
 *   - Le gateway n'ignore pas les erreurs, il les publie → l'appelant peut retry
 *   - Le gateway skip ses propres events (évite auto-relay)
 *   - Fenêtre `since` = now - 5 min → pas de rejeu d'anciennes transactions
 */

import { nostrClient as defaultNostrClient, Kind, type NostrClient, type TxRelayPayload } from '@/utils/nostr-client';
import { broadcastTransaction } from '@/utils/mempool';
import type { Event as NostrEvent } from 'nostr-tools';

// ─── Constants ────────────────────────────────────────────────────────────────

const RELAY_WINDOW_SECS = 5 * 60;        // 5 minutes — fenêtre de réception du gateway
const CLIENT_TIMEOUT_MS = 60_000;        // 1 min — timeout côté demandeur
const CASHU_ACK_TIMEOUT_MS = 30_000;     // 30s — ack Cashu (best-effort)

// ─── Types ────────────────────────────────────────────────────────────────────

export type RelayType = 'bitcoin_tx' | 'cashu_token' | 'cashu_melt';

export interface RelayConfirmation {
  /** true si le gateway a broadcasté / traité avec succès */
  success: boolean;
  /** txid retourné par mempool (bitcoin_tx uniquement) */
  txid?: string;
  /** Message d'erreur si success = false */
  error?: string;
  /** Clé publique hex du gateway qui a traité */
  gatewayPubkey: string;
  /** Event ID de la demande originale */
  originalEventId: string;
}

export interface PendingRelay {
  eventId: string;
  type: RelayType;
  data: string;
  sentAt: number;
  status: 'pending' | 'confirmed' | 'failed';
  txid?: string;
  error?: string;
}

// ─── TxRelayGateway ───────────────────────────────────────────────────────────

/**
 * Gateway côté nœud internet.
 * Écoute les kind:9001 entrants et broadcast les transactions.
 */
export class TxRelayGateway {
  private nostr: NostrClient;
  private mempoolUrl: string;
  private unsub: (() => void) | null = null;
  private processed = new Set<string>();

  /** Nombre de relays traités depuis le démarrage */
  relayedCount = 0;
  /** Nombre d'erreurs depuis le démarrage */
  errorCount = 0;

  constructor(
    nostrClientInstance: NostrClient = defaultNostrClient,
    mempoolUrl = 'https://mempool.space/api',
  ) {
    this.nostr = nostrClientInstance;
    this.mempoolUrl = mempoolUrl;
  }

  /**
   * Démarre le gateway.
   * `since` : timestamp Unix — ignore les events plus anciens (défaut : 5 min)
   */
  start(since?: number): void {
    if (this.unsub) this.stop();

    const sinceTs = since ?? Math.floor(Date.now() / 1000) - RELAY_WINDOW_SECS;

    this.unsub = this.nostr.subscribe(
      [{ kinds: [Kind.TxRelay], since: sinceTs }],
      (event) => {
        this._processEvent(event).catch((err) => {
          console.error('[TxRelayGateway] Erreur non catchée:', err);
        });
      },
    );

    console.log('[TxRelayGateway] Démarré — since:', new Date(sinceTs * 1000).toISOString());
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    console.log('[TxRelayGateway] Arrêté');
  }

  get isRunning(): boolean {
    return this.unsub !== null;
  }

  // ── Traitement des events entrants ─────────────────────────────────────────

  private async _processEvent(event: NostrEvent): Promise<void> {
    // Ignorer les events déjà traités (idempotence)
    if (this.processed.has(event.id)) return;
    this.processed.add(event.id);

    // Ignorer nos propres events (évite l'auto-relay)
    if (event.pubkey === this.nostr.publicKey) return;

    // Ignorer les events de confirmation (tag relay_result) — pas des demandes
    const isResult = event.tags.some(t => t[0] === 't' && t[1] === 'relay_result');
    if (isResult) return;

    let payload: TxRelayPayload;
    try {
      payload = JSON.parse(event.content) as TxRelayPayload;
      if (!payload.type || !payload.data) return;
    } catch {
      console.warn('[TxRelayGateway] Payload invalide, ignoré:', event.id.slice(0, 12));
      return;
    }

    console.log('[TxRelayGateway] Traitement:', payload.type, '— event:', event.id.slice(0, 16) + '…');

    try {
      await this._dispatchRelay(payload, event);
      this.relayedCount++;
    } catch (err) {
      this.errorCount++;
      const error = err instanceof Error ? err.message : String(err);
      console.error('[TxRelayGateway] Erreur relay:', error);
      await this._publishResult(event.id, event.pubkey, { success: false, error });
    }
  }

  private async _dispatchRelay(payload: TxRelayPayload, event: NostrEvent): Promise<void> {
    switch (payload.type) {
      case 'bitcoin_tx': {
        // Broadcast la transaction Bitcoin sur le réseau
        const { txid } = await broadcastTransaction(payload.data, this.mempoolUrl);
        await this._publishResult(event.id, event.pubkey, { success: true, txid });
        console.log('[TxRelayGateway] TX broadcastée:', txid);
        break;
      }

      case 'cashu_token': {
        // Les tokens Cashu sont auto-porteurs — confirmer la réception
        // Le destinataire peut les réclamer directement via le mint
        await this._publishResult(event.id, event.pubkey, {
          success: true,
          txid: undefined,
          data: payload.data,
        });
        console.log('[TxRelayGateway] Token Cashu reçu et acquitté');
        break;
      }

      case 'cashu_melt': {
        // Phase 3.5 — nécessite un wallet Lightning côté gateway
        // Pour l'instant : refuser proprement avec message clair
        throw new Error('cashu_melt non encore supporté — nécessite un wallet Lightning sur le gateway');
      }

      default: {
        throw new Error(`Type de relay inconnu: ${(payload as any).type}`);
      }
    }
  }

  private async _publishResult(
    originalEventId: string,
    requesterPubkey: string,
    result: { success: boolean; txid?: string; error?: string; data?: string },
  ): Promise<void> {
    await this.nostr.publish({
      kind: Kind.TxRelay,
      content: JSON.stringify({
        success: result.success,
        txid: result.txid,
        error: result.error,
        data: result.data,
      }),
      tags: [
        ['e', originalEventId],        // référence à la demande originale
        ['p', requesterPubkey],         // notification au demandeur
        ['t', 'relay_result'],          // tag pour filtrage
      ],
      created_at: Math.floor(Date.now() / 1000),
    });
  }
}

// ─── Client — envoi via relay ─────────────────────────────────────────────────

/**
 * Envoie une transaction Bitcoin signée via un gateway Nostr.
 *
 * Flow :
 *   1. Publie kind:9001 { type: 'bitcoin_tx', data: txHex }
 *   2. S'abonne aux confirmations kind:9001 #e=eventId #t=relay_result
 *   3. Résout avec { txid, gatewayPubkey } à la première confirmation
 *   4. Rejette si erreur ou si timeout atteint
 *
 * @param txHex - Transaction Bitcoin signée en hex
 * @param opts.timeoutMs - Timeout avant abandon (défaut : 60s)
 * @param opts.nostrClient - Instance Nostr (défaut : singleton global)
 */
export async function sendBitcoinTxViaNostr(
  txHex: string,
  opts: {
    timeoutMs?: number;
    nostrClient?: NostrClient;
  } = {},
): Promise<RelayConfirmation> {
  const client = opts.nostrClient ?? defaultNostrClient;
  const timeoutMs = opts.timeoutMs ?? CLIENT_TIMEOUT_MS;

  // 1. Publier la demande de relay
  const requestEvent = await client.publishTxRelay({ type: 'bitcoin_tx', data: txHex });
  const requestId = requestEvent.id;
  console.log('[TxRelay] Demande publiée — id:', requestId.slice(0, 16) + '…');

  // 2. Attendre la confirmation d'un gateway
  return new Promise<RelayConfirmation>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(
        `[TxRelay] Timeout ${timeoutMs / 1000}s — aucun gateway n'a répondu. ` +
        'Vérifiez votre connexion Nostr ou réessayez plus tard.'
      ));
    }, timeoutMs);

    const unsub = client.subscribe(
      [{ kinds: [Kind.TxRelay], '#e': [requestId], '#t': ['relay_result'] }],
      (event) => {
        try {
          const result = JSON.parse(event.content) as {
            success: boolean;
            txid?: string;
            error?: string;
          };

          clearTimeout(timer);
          unsub();

          if (result.success && result.txid) {
            resolve({
              success: true,
              txid: result.txid,
              gatewayPubkey: event.pubkey,
              originalEventId: requestId,
            });
          } else {
            reject(new Error(result.error ?? 'Gateway a échoué sans message d\'erreur'));
          }
        } catch {
          // Confirmation malformée — ignorer et attendre la prochaine
          console.warn('[TxRelay] Confirmation malformée ignorée');
        }
      },
    );
  });
}

/**
 * Envoie un token Cashu via un gateway Nostr.
 * Les tokens Cashu sont auto-porteurs — le gateway acquitte la réception
 * mais le token reste valide même sans ack.
 *
 * @param token - Token Cashu encodé (cashuA…)
 * @param targetMint - URL du mint cible (optionnel, pour filtrage gateway)
 */
export async function sendCashuTokenViaNostr(
  token: string,
  targetMint?: string,
  opts: { timeoutMs?: number; nostrClient?: NostrClient } = {},
): Promise<RelayConfirmation> {
  const client = opts.nostrClient ?? defaultNostrClient;
  const timeoutMs = opts.timeoutMs ?? CASHU_ACK_TIMEOUT_MS;

  const requestEvent = await client.publishTxRelay({
    type: 'cashu_token',
    data: token,
    targetMint,
  });
  const requestId = requestEvent.id;
  console.log('[TxRelay] Token Cashu publié — id:', requestId.slice(0, 16) + '…');

  return new Promise<RelayConfirmation>((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      // Timeout non-fatal pour Cashu — le token reste valide
      console.warn('[TxRelay] Aucun ack Cashu dans', timeoutMs / 1000, 's — token toujours valide');
      resolve({
        success: false,
        error: 'Timeout — aucun gateway n\'a acquitté (token toujours valide)',
        gatewayPubkey: '',
        originalEventId: requestId,
      });
    }, timeoutMs);

    const unsub = client.subscribe(
      [{ kinds: [Kind.TxRelay], '#e': [requestId], '#t': ['relay_result'] }],
      (event) => {
        try {
          const result = JSON.parse(event.content) as { success: boolean; error?: string };
          clearTimeout(timer);
          unsub();
          resolve({
            success: result.success,
            error: result.error,
            gatewayPubkey: event.pubkey,
            originalEventId: requestId,
          });
        } catch {
          console.warn('[TxRelay] Ack Cashu malformé ignoré');
        }
      },
    );
  });
}

// ─── Utilitaire : détection TX déjà broadcast ─────────────────────────────────

/**
 * Vérifie si une erreur mempool indique que la TX est déjà connue.
 * Dans ce cas, le relay peut être considéré comme réussi (idempotent).
 */
export function isTxAlreadyKnown(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('txn-already-in-mempool') ||
    msg.includes('transaction already in block chain') ||
    msg.includes('already known') ||
    msg.includes('duplicate') ||
    msg.includes('txn already in mempool')
  );
}
