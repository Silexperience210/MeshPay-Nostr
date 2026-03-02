/**
 * NostrClient — Transport Nostr pour MeshPay
 *
 * Implémentation 100% compatible React Native / Hermes :
 * - Pas de crypto.subtle (non disponible sur Hermes)
 * - NIP-04 reimplementé via @noble/curves + @noble/ciphers (AES-CBC)
 * - NIP-06 key derivation via @scure/bip32 (même lib que le wallet Bitcoin)
 *
 * NIPs supportés :
 *   NIP-01 : Protocole de base (events, signatures)
 *   NIP-04 : DMs chiffrés (AES-256-CBC + ECDH secp256k1)
 *   NIP-06 : Dérivation clés depuis mnemonic BIP39
 *   NIP-17 : Gift Wrap DMs (Phase 2)
 *   NIP-19 : Encodage bech32 (npub / nsec)
 *   NIP-28 : Channels publics
 *   NIP-65 : Liste de relays préférés
 */

import {
  finalizeEvent,
  verifyEvent,
  getEventHash,
  getPublicKey,
  type Event as NostrEvent,
  type EventTemplate,
  type Filter,
} from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1';
import { cbc } from '@noble/ciphers/aes';
// @ts-ignore — subpath exports
import { sha256 } from '@noble/hashes/sha2.js';
import { mnemonicToSeed } from '@/utils/bitcoin';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Chemin de dérivation BIP-44 pour Nostr (NIP-06) */
const NIP06_PATH = "m/44'/1237'/0'/0/0";

/** Relays publics recommandés — classés par fiabilité */
export const DEFAULT_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://nostr.wine',
  'wss://relay.snort.social',
];

const OFFLINE_QUEUE_MAX = 100;
const CONNECT_TIMEOUT_MS = 5_000;

// ─── Event kinds ─────────────────────────────────────────────────────────────

export const Kind = {
  Metadata: 0,
  Text: 1,
  EncryptedDM: 4,       // NIP-04
  ChannelCreate: 40,    // NIP-28
  ChannelMetadata: 41,  // NIP-28
  ChannelMessage: 42,   // NIP-28
  RelayList: 10002,     // NIP-65
  /** Kind custom MeshPay — relay de transactions Bitcoin/Cashu */
  TxRelay: 9001,
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NostrKeypair {
  /** Clé privée 32 bytes — ne jamais exposer en dehors du client */
  secretKey: Uint8Array;
  /** Clé publique hex 64 chars (x-only, format Nostr) */
  publicKey: string;
  /** Clé publique encodée bech32 */
  npub: string;
  /** Clé privée encodée bech32 — afficher uniquement sur demande explicite */
  nsec: string;
}

export type RelayStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface RelayInfo {
  url: string;
  status: RelayStatus;
}

export interface TxRelayPayload {
  type: 'bitcoin_tx' | 'cashu_token' | 'cashu_melt';
  /** Transaction hex (bitcoin_tx) ou token JSON serialisé (cashu_*) */
  data: string;
  /** URL du mint cible (cashu uniquement) */
  targetMint?: string;
}

interface PendingEvent {
  template: EventTemplate;
  resolve: (event: NostrEvent) => void;
  reject: (err: Error) => void;
}

// ─── NIP-06 — Dérivation de clés depuis mnemonic BIP39 ───────────────────────

/**
 * Dérive une keypair Nostr depuis un mnemonic BIP39.
 * Utilise le chemin NIP-06 : m/44'/1237'/0'/0/0
 * Même mnemonic que le wallet Bitcoin → identité unifiée.
 */
export function deriveNostrKeypair(mnemonic: string): NostrKeypair {
  const seed = mnemonicToSeed(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const child = master.derive(NIP06_PATH);

  if (!child.privateKey) {
    throw new Error('[Nostr] Échec dérivation NIP-06 : clé privée absente');
  }

  const secretKey = child.privateKey;
  const publicKey = getPublicKey(secretKey);

  return {
    secretKey,
    publicKey,
    npub: nip19.npubEncode(publicKey),
    nsec: nip19.nsecEncode(secretKey),
  };
}

// ─── NIP-04 — Chiffrement/déchiffrement compatible React Native ──────────────
//
//  Reimplementé sans crypto.subtle (absent de Hermes/React Native).
//  Algorithme identique à la spec NIP-04 :
//    1. ECDH secp256k1 → shared point → x-coordinate (32 bytes) = clé AES
//    2. IV aléatoire 16 bytes
//    3. AES-256-CBC (padding auto via @noble/ciphers)
//    4. Format de sortie : "<ciphertext_b64>?iv=<iv_b64>"

function nip04Encrypt(senderPrivKey: Uint8Array, recipientPubKey: string, plaintext: string): string {
  // 1. ECDH — préfixer la clé publique x-only avec 02 pour obtenir une clé compressée
  const sharedPoint = secp256k1.getSharedSecret(senderPrivKey, '02' + recipientPubKey);
  const aesKey = sharedPoint.slice(1, 33); // x-coordinate uniquement

  // 2. IV aléatoire 16 bytes
  const iv = crypto.getRandomValues(new Uint8Array(16));

  // 3. Chiffrement AES-256-CBC
  const encodedText = new TextEncoder().encode(plaintext);
  const ciphertext = cbc(aesKey, iv).encrypt(encodedText);

  // 4. Format NIP-04
  const ciphertextB64 = Buffer.from(ciphertext).toString('base64');
  const ivB64 = Buffer.from(iv).toString('base64');
  return `${ciphertextB64}?iv=${ivB64}`;
}

function nip04Decrypt(receiverPrivKey: Uint8Array, senderPubKey: string, ciphertextMsg: string): string {
  const [ciphertextB64, ivPart] = ciphertextMsg.split('?iv=');
  if (!ciphertextB64 || !ivPart) {
    throw new Error('[Nostr] NIP-04 : format de message chiffré invalide');
  }

  // 1. ECDH
  const sharedPoint = secp256k1.getSharedSecret(receiverPrivKey, '02' + senderPubKey);
  const aesKey = sharedPoint.slice(1, 33);

  // 2. Déchiffrement
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const iv = Buffer.from(ivPart, 'base64');
  const plaintext = cbc(aesKey, iv).decrypt(ciphertext);

  return new TextDecoder().decode(plaintext);
}

// ─── NostrClient ─────────────────────────────────────────────────────────────

export class NostrClient {
  private pool: SimplePool;
  private keypair: NostrKeypair | null = null;
  private relayUrls: string[] = [];
  private relayStatus = new Map<string, RelayStatus>();
  private offlineQueue: PendingEvent[] = [];
  private onStatusChange?: (relays: RelayInfo[]) => void;

  constructor() {
    this.pool = new SimplePool();
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  setKeypair(keypair: NostrKeypair): void {
    this.keypair = keypair;
  }

  setOnStatusChange(cb: (relays: RelayInfo[]) => void): void {
    this.onStatusChange = cb;
  }

  // ── Connexion ──────────────────────────────────────────────────────────────

  async connect(relays: string[] = DEFAULT_RELAYS): Promise<void> {
    this.relayUrls = relays;
    for (const url of relays) {
      this.relayStatus.set(url, 'connecting');
    }
    this._notifyStatus();

    // Ping léger : subscribe à 1 event pour établir les connexions WS
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // Timeout → on considère quand même connecté (certains relays sont lents)
        for (const url of this.relayUrls) {
          if (this.relayStatus.get(url) === 'connecting') {
            this.relayStatus.set(url, 'connected');
          }
        }
        this._notifyStatus();
        resolve();
      }, CONNECT_TIMEOUT_MS);

      try {
        const sub = this.pool.subscribeMany(
          this.relayUrls,
          [{ kinds: [Kind.Text], limit: 1 }],
          {
            oneose: () => {
              clearTimeout(timeout);
              for (const url of this.relayUrls) {
                this.relayStatus.set(url, 'connected');
              }
              this._notifyStatus();
              sub.close();
              resolve();
            },
          },
        );
      } catch {
        clearTimeout(timeout);
        for (const url of this.relayUrls) {
          this.relayStatus.set(url, 'error');
        }
        this._notifyStatus();
        resolve(); // Ne pas bloquer le démarrage de l'app
      }
    });

    // Renvoyer les events en attente
    await this._drainOfflineQueue();
  }

  disconnect(): void {
    this.pool.close(this.relayUrls);
    for (const url of this.relayUrls) {
      this.relayStatus.set(url, 'disconnected');
    }
    this._notifyStatus();
  }

  get isConnected(): boolean {
    return Array.from(this.relayStatus.values()).some(s => s === 'connected');
  }

  getRelayInfos(): RelayInfo[] {
    return this.relayUrls.map(url => ({
      url,
      status: this.relayStatus.get(url) ?? 'disconnected',
    }));
  }

  // ── Publication ────────────────────────────────────────────────────────────

  /**
   * Publie un event sur tous les relays connectés.
   * Si hors ligne, met en queue (max 100 events) et publie à la reconnexion.
   */
  async publish(template: EventTemplate): Promise<NostrEvent> {
    if (!this.keypair) {
      throw new Error('[Nostr] Keypair non initialisée — wallet requis avant publish');
    }

    const event = finalizeEvent(template, this.keypair.secretKey);

    if (!this.isConnected) {
      if (this.offlineQueue.length >= OFFLINE_QUEUE_MAX) {
        throw new Error('[Nostr] Queue offline pleine (max 100 événements)');
      }
      console.warn('[Nostr] Hors ligne — event kind:', template.kind, 'mis en queue');
      return new Promise<NostrEvent>((resolve, reject) => {
        this.offlineQueue.push({ template, resolve, reject });
      });
    }

    const publishPromises = this.pool.publish(this.relayUrls, event);
    await Promise.any(publishPromises).catch(() => {
      console.warn('[Nostr] Aucun relay n\'a accepté l\'event kind:', event.kind);
    });

    console.log('[Nostr] Publié — kind:', event.kind, 'id:', event.id.slice(0, 12) + '…');
    return event;
  }

  // ── Abonnements ────────────────────────────────────────────────────────────

  /**
   * S'abonne à des events selon des filtres Nostr.
   * Retourne une fonction de désabonnement.
   */
  subscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEOSE?: () => void,
  ): () => void {
    const sub = this.pool.subscribeMany(this.relayUrls, filters, {
      onevent: (event) => {
        // Double validation : hash + signature (verifyEvent seul ne vérifie pas le hash)
        if (getEventHash(event) !== event.id) {
          console.warn('[Nostr] Hash/ID invalide — event ignoré:', event.id.slice(0, 12));
          return;
        }
        if (!verifyEvent(event)) {
          console.warn('[Nostr] Signature invalide — event ignoré:', event.id.slice(0, 12));
          return;
        }
        onEvent(event);
      },
      oneose: onEOSE,
    });

    return () => sub.close();
  }

  // ── NIP-04 : DMs chiffrés ─────────────────────────────────────────────────

  /**
   * Envoie un DM chiffré NIP-04 à une clé publique Nostr.
   */
  async publishDM(recipientPubKey: string, content: string): Promise<NostrEvent> {
    if (!this.keypair) throw new Error('[Nostr] Keypair non initialisée');

    const ciphertext = nip04Encrypt(this.keypair.secretKey, recipientPubKey, content);
    return this.publish({
      kind: Kind.EncryptedDM,
      content: ciphertext,
      tags: [['p', recipientPubKey]],
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * S'abonne aux DMs entrants et les déchiffre automatiquement.
   * Retourne une fonction de désabonnement.
   */
  subscribeDMs(
    onDM: (from: string, content: string, event: NostrEvent) => void,
  ): () => void {
    if (!this.keypair) throw new Error('[Nostr] Keypair non initialisée');

    const myPubKey = this.keypair.publicKey;

    return this.subscribe(
      [{ kinds: [Kind.EncryptedDM], '#p': [myPubKey] }],
      (event) => {
        try {
          const plaintext = nip04Decrypt(this.keypair!.secretKey, event.pubkey, event.content);
          onDM(event.pubkey, plaintext, event);
        } catch {
          console.warn('[Nostr] Déchiffrement DM échoué — ignoré:', event.id.slice(0, 12));
        }
      },
    );
  }

  // ── NIP-28 : Channels ─────────────────────────────────────────────────────

  /**
   * Crée un channel public. Retourne l'event dont l'id est l'identifiant du channel.
   */
  async createChannel(name: string, about: string, picture?: string): Promise<NostrEvent> {
    return this.publish({
      kind: Kind.ChannelCreate,
      content: JSON.stringify({ name, about, picture: picture ?? '' }),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Envoie un message dans un channel NIP-28.
   */
  async publishChannelMessage(
    channelId: string,
    content: string,
    replyToId?: string,
  ): Promise<NostrEvent> {
    const recommendedRelay = this.relayUrls[0] ?? '';
    const tags: string[][] = [['e', channelId, recommendedRelay, 'root']];
    if (replyToId) {
      tags.push(['e', replyToId, recommendedRelay, 'reply']);
    }
    return this.publish({
      kind: Kind.ChannelMessage,
      content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * S'abonne aux messages d'un channel.
   * `since` : timestamp Unix — récupère uniquement les messages après cette date.
   */
  subscribeChannel(
    channelId: string,
    onMessage: (event: NostrEvent) => void,
    since?: number,
  ): () => void {
    return this.subscribe(
      [{ kinds: [Kind.ChannelMessage], '#e': [channelId], since }],
      onMessage,
    );
  }

  // ── TX Relay : Bitcoin / Cashu ─────────────────────────────────────────────

  /**
   * Publie une transaction Bitcoin ou un token Cashu sur les relays.
   * N'importe quel nœud abonné avec internet peut ensuite la broadcaster.
   * Kind custom 9001 — spécifique à MeshPay.
   */
  async publishTxRelay(payload: TxRelayPayload): Promise<NostrEvent> {
    return this.publish({
      kind: Kind.TxRelay,
      content: JSON.stringify(payload),
      tags: [['t', payload.type]],
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * S'abonne aux transactions relayées via Nostr.
   * Utile pour les nœuds gateway qui ont internet et broadcastent les txs reçues.
   */
  subscribeTxRelay(
    onTx: (payload: TxRelayPayload, event: NostrEvent) => void,
  ): () => void {
    return this.subscribe(
      [{ kinds: [Kind.TxRelay] }],
      (event) => {
        try {
          const payload = JSON.parse(event.content) as TxRelayPayload;
          if (payload.type && payload.data) {
            onTx(payload, event);
          }
        } catch {
          console.warn('[Nostr] TxRelay payload invalide — ignoré:', event.id.slice(0, 12));
        }
      },
    );
  }

  // ── NIP-65 : Liste de relays préférés ─────────────────────────────────────

  /**
   * Publie la liste des relays préférés de l'utilisateur (NIP-65).
   */
  async publishRelayList(relays: Array<{ url: string; read?: boolean; write?: boolean }>): Promise<NostrEvent> {
    const tags = relays.map(({ url, read = true, write = true }) => {
      if (read && write) return ['r', url];
      if (read) return ['r', url, 'read'];
      return ['r', url, 'write'];
    });

    return this.publish({
      kind: Kind.RelayList,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  // ── Helpers privés ────────────────────────────────────────────────────────

  private async _drainOfflineQueue(): Promise<void> {
    if (this.offlineQueue.length === 0) return;

    const queue = [...this.offlineQueue];
    this.offlineQueue = [];
    console.log('[Nostr] Envoi de', queue.length, 'events en attente (offline queue)');

    for (const pending of queue) {
      try {
        const event = await this.publish(pending.template);
        pending.resolve(event);
      } catch (err) {
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private _notifyStatus(): void {
    this.onStatusChange?.(this.getRelayInfos());
  }
}

// ─── Singleton app-wide ───────────────────────────────────────────────────────
// Une seule instance partagée — configurée par NostrProvider au démarrage.
export const nostrClient = new NostrClient();
