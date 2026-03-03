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
// @ts-ignore — subpath exports
import * as nip17 from 'nostr-tools/nip17';
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
  EncryptedDM: 4,            // NIP-04
  Seal: 13,                  // NIP-59 (envelope du Gift Wrap)
  PrivateDirectMessage: 14,  // NIP-17 (rumor — message en clair à l'intérieur du Seal)
  ChannelCreate: 40,         // NIP-28
  ChannelMetadata: 41,       // NIP-28
  ChannelMessage: 42,        // NIP-28
  RelayList: 10002,          // NIP-65
  GiftWrap: 1059,            // NIP-59 (wrapper externe publié sur les relays)
  /** Kind custom MeshPay — relay de transactions Bitcoin/Cashu */
  TxRelay: 9001,
} as const;

// ─── deriveChannelId ──────────────────────────────────────────────────────────

/**
 * Calcule un identifiant de canal NIP-28 déterministe depuis un nom de forum.
 *
 * Tous les nœuds MeshPay obtiennent le même channelId pour le même channelName
 * sans avoir à se coordonner préalablement via un event kind:40.
 *
 * L'ID est un hash SHA-256 hex du nom normalisé, formaté comme un event Nostr ID.
 * Utilisé pour filtrer les kind:42 : `{kinds:[42], '#e': [channelId]}`.
 */
export function deriveChannelId(channelName: string): string {
  const input = new TextEncoder().encode(
    `meshpay:forum:${channelName.toLowerCase().trim()}`
  );
  const hash = sha256(input);
  return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
}

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

/** Payload de présence / découverte pair (kind:9001 type=presence) */
export interface PresencePayload {
  type: 'presence';
  /** Identifiant MeshCore du nœud ex: "MESH-A7F2" */
  nodeId: string;
  /** Nom d'affichage optionnel */
  name?: string;
  /** Latitude GPS (optionnel) */
  lat?: number;
  /** Longitude GPS (optionnel) */
  lng?: number;
  /** true = en ligne, false = déconnexion propre */
  online: boolean;
  /** Timestamp Unix ms */
  ts: number;
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

  /** Clé publique hex 64 chars de l'utilisateur courant, null si keypair non initialisée */
  get publicKey(): string | null {
    return this.keypair?.publicKey ?? null;
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

  // ── NIP-17 : Gift Wrap DMs (sealed sender) ───────────────────────────────

  /**
   * Envoie un DM chiffré NIP-17 (Gift Wrap — sealed sender).
   *
   * Crée deux gift wraps (kind:1059) :
   *   1. Pour le destinataire — chiffré avec sa clé publique
   *   2. Pour l'expéditeur  — copie chiffrée avec sa propre clé (boîte d'envoi)
   *
   * Chaque wrap est signé avec une clé éphémère aléatoire → l'expéditeur
   * ne peut pas être déduit en analysant les relays.
   *
   * Différence avec NIP-04 (kind:4) :
   *   - NIP-04 : contenu chiffré mais pubkey expéditeur visible
   *   - NIP-17 : pubkey masquée (clé éphémère), timestamp aléatoire ±2 jours
   */
  async publishDMSealed(recipientPubKey: string, content: string): Promise<NostrEvent> {
    if (!this.keypair) throw new Error('[Nostr] Keypair non initialisée');
    if (!this.isConnected) throw new Error('[Nostr] Hors ligne — Gift Wrap nécessite une connexion active');

    // wrapManyEvents crée automatiquement : [copy_for_sender, copy_for_recipient]
    const wraps: NostrEvent[] = nip17.wrapManyEvents(
      this.keypair.secretKey,
      [{ publicKey: recipientPubKey }],
      content,
    );

    // Publier tous les wraps en parallèle (ne pas bloquer si un relay refuse)
    await Promise.all(
      wraps.map(wrap =>
        Promise.any(this.pool.publish(this.relayUrls, wrap)).catch(() => {
          console.warn('[Nostr] Gift Wrap : relay n\'a pas accepté kind:1059');
        }),
      ),
    );

    console.log('[Nostr] Gift Wrap envoyé — kind:1059, destinataire:', recipientPubKey.slice(0, 12) + '…');
    // Retourner le wrap destinataire (index 1 — index 0 est la copie expéditeur)
    return wraps[1] ?? wraps[0];
  }

  /**
   * S'abonne aux DMs NIP-17 (Gift Wrap kind:1059).
   *
   * Déchiffre automatiquement le double enrobage (Gift Wrap → Seal → Rumor).
   * Rétrocompat : les DMs NIP-04 (kind:4) sont toujours lus via subscribeDMs().
   */
  subscribeDMsSealed(
    onDM: (from: string, content: string, event: NostrEvent) => void,
  ): () => void {
    if (!this.keypair) throw new Error('[Nostr] Keypair non initialisée');

    const myPubKey = this.keypair.publicKey;

    return this.subscribe(
      [{ kinds: [Kind.GiftWrap], '#p': [myPubKey] }],
      (event) => {
        try {
          const rumor = nip17.unwrapEvent(event, this.keypair!.secretKey);
          // Vérifier que c'est bien un kind:14 (PrivateDirectMessage)
          if (rumor.kind !== Kind.PrivateDirectMessage) {
            console.warn('[Nostr] Gift Wrap inattendu kind:', rumor.kind, '— ignoré');
            return;
          }
          onDM(rumor.pubkey, rumor.content, event);
        } catch {
          console.warn('[Nostr] Déchiffrement Gift Wrap échoué — ignoré:', event.id.slice(0, 12));
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

  /**
   * Découverte de forums publics via NIP-28 kind:40 (ChannelCreate).
   * Récupère les 50 forums les plus récents sur les relays.
   */
  subscribeForums(
    onChannel: (event: NostrEvent) => void,
    limit = 50,
  ): () => void {
    return this.subscribe(
      [{ kinds: [Kind.ChannelCreate], limit }],
      onChannel,
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

  // ── Découverte / Présence (kind:0 + kind:9001 type=presence) ────────────────

  /**
   * Publie les métadonnées NIP-01 (kind:0) du nœud MeshPay.
   * Annonce le nodeId custom dans le champ `meshpay_node_id`.
   */
  async publishMetadata(nodeId: string, displayName?: string): Promise<NostrEvent> {
    const meta = {
      name: displayName || nodeId,
      about: 'MeshPay node',
      meshpay_node_id: nodeId,
    };
    return this.publish({
      kind: Kind.Metadata,
      content: JSON.stringify(meta),
      tags: [['t', 'meshpay']],
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Publie une présence MeshPay (kind:9001 type=presence).
   * Utilisé pour la découverte des pairs sans MQTT.
   *
   * Les nœuds qui souscrivent via `subscribePresence()` reçoivent
   * ces annonces et mettent à jour leur radar de pairs.
   */
  async publishPresence(nodeId: string, lat?: number, lng?: number): Promise<NostrEvent> {
    const payload: PresencePayload = {
      type: 'presence',
      nodeId,
      online: true,
      ts: Date.now(),
      ...(lat !== undefined && lng !== undefined ? { lat, lng } : {}),
    };
    return this.publish({
      kind: Kind.TxRelay,
      content: JSON.stringify(payload),
      tags: [['t', 'presence']],
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * S'abonne aux annonces de présence des pairs MeshPay.
   * Filtre kind:9001 avec tag #t=presence — ne reçoit PAS les TX relay.
   */
  subscribePresence(
    onPresence: (payload: PresencePayload, event: NostrEvent) => void,
  ): () => void {
    return this.subscribe(
      [{ kinds: [Kind.TxRelay], '#t': ['presence'] }],
      (event) => {
        try {
          const payload = JSON.parse(event.content) as PresencePayload;
          if (payload.type !== 'presence' || !payload.nodeId) return;
          onPresence(payload, event);
        } catch {
          console.warn('[Nostr] Présence invalide — ignorée:', event.id.slice(0, 12));
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
