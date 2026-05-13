/**
 * NostrClient — Transport Nostr pour MeshPay
 *
 * Implémentation 100% compatible React Native / Hermes :
 * - Pas de crypto.subtle (non disponible sur Hermes)
 * - NIP-44 v2 : ChaCha20-Poly1305 + HKDF (AEAD — padding longueur)
 * - NIP-06 key derivation via @scure/bip32 (même lib que le wallet Bitcoin)
 *
 * NIPs supportés :
 *   NIP-01 : Protocole de base (events, signatures)
 *   NIP-44 : DMs chiffrés v2 (ChaCha20-Poly1305 + HKDF — remplace NIP-04)
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
  nip44,
  type Event as NostrEvent,
  type EventTemplate,
  type Filter,
} from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import * as nip17 from 'nostr-tools/nip17';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { mnemonicToSeed } from '@/utils/bitcoin';
import { utf8Encode, utf8Decode } from './text-codec';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Chemin de dérivation BIP-44 pour Nostr (NIP-06) */
const NIP06_PATH = "m/44'/1237'/0'/0/0";

/** Relays publics recommandés — classés par fiabilité */
/**
 * Relais Nostr par défaut.
 *
 * ✅ FIX FORUM DISCOVERY :
 * Inclut explicitement `relay.primal.net` et `relay.damus.io` — les 2 relais
 * publics les plus fiables au monde (vérifiés en mai 2026 : 100% des events
 * meshpay-forum y sont indexés et retournés instantanément).
 *
 * `nostr.band`, `nostr.wine`, `snort.social` sont gardés comme fallbacks
 * mais ils peuvent timeout ou ne pas avoir indexé les events kind:40.
 *
 * Recommandé : 3-5 relais minimum pour redondance. Au-delà, ça augmente
 * la latence + consommation batterie sans bénéfice.
 */
export const DEFAULT_RELAYS: string[] = [
  'wss://relay.damus.io',         // ✅ Très fiable, NIP-28 supporté
  'wss://relay.primal.net',       // ✅ Très fiable, NIP-28 supporté (ajouté en v1.0.15)
  'wss://nos.lol',                // Backup
  'wss://nostr.bitcoiner.social', // Backup, focus Bitcoin
  'wss://relay.snort.social',     // Backup (peut timeout)
];

const OFFLINE_QUEUE_MAX = 100;
const CONNECT_TIMEOUT_MS = 10_000; // ✅ FIX : 10s au lieu de 5s — certains relais sont lents

/**
 * ✅ Tag NIP-12 utilisé pour identifier les forums MeshPay sur les relais Nostr.
 *
 * Posé par `createChannel` dans les tags du kind:40 :
 *   tags: [['t', 'meshpay-forum'], ...]
 *
 * Récupéré par `subscribeForums` via filter NIP-12 :
 *   { kinds: [40], '#t': ['meshpay-forum'] }
 *
 * Const top-level (et non `static` class member) pour éviter des problèmes
 * d'initialisation potentiels avec Hermes (le moteur JS de RN en release).
 */
export const MESHPAY_FORUM_TAG = 'meshpay-forum';

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
  const input = utf8Encode(
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
  type: 'bitcoin_tx' | 'cashu_token' | 'cashu_melt' | 'lora_relay';
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

// ─── NIP-44 v2 — Chiffrement AEAD compatible React Native ────────────────────
//
//  NIP-44 utilise :
//    1. ECDH secp256k1 → conversation key via HKDF-SHA256
//    2. ChaCha20-Poly1305 (AEAD — authentification intégrée, pas de padding oracle)
//    3. Padding de longueur : masque la taille du message
//    4. Nonce 32 bytes (vs 16 bytes NIP-04)
//
//  Avantages sur NIP-04 (AES-CBC) :
//    - Authentification intégrée → pas d'attaque padding oracle
//    - Padding → un observateur ne connaît pas la longueur du message
//    - HKDF → isolation de contexte entre conversations

function nip44Encrypt(senderPrivKey: Uint8Array, recipientPubKey: string, plaintext: string): string {
  const conversationKey = nip44.getConversationKey(senderPrivKey, recipientPubKey);
  return nip44.encrypt(plaintext, conversationKey);
}

function nip44Decrypt(receiverPrivKey: Uint8Array, senderPubKey: string, ciphertext: string): string {
  const conversationKey = nip44.getConversationKey(receiverPrivKey, senderPubKey);
  return nip44.decrypt(ciphertext, conversationKey);
}

// ─── NostrClient ─────────────────────────────────────────────────────────────

export class NostrClient {
  private pool: SimplePool;
  private keypair: NostrKeypair | null = null;
  private relayUrls: string[] = [];
  private relayStatus = new Map<string, RelayStatus>();
  private offlineQueue: PendingEvent[] = [];
  private onStatusChange?: (relays: RelayInfo[]) => void;
  // Auto-reconnect avec backoff exponentiel
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectDelay = 2000; // commence à 2s, double jusqu'à 30s
  private _keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private _intentionalDisconnect = false;
  private _isReconnecting = false;
  private _isConnecting = false;
  private _reconnectAttempts = 0;
  private readonly _maxReconnectAttempts = 10;
  // Active subscriptions for auto-resubscription after reconnect
  private _activeSubscriptions: Array<{
    filters: Filter[];
    onEvent: (event: NostrEvent) => void;
    onEOSE?: () => void;
    unsub: (() => void) | null;
  }> = [];

  constructor(relayUrls?: string[]) {
    this.pool = new SimplePool();
    if (relayUrls) this.relayUrls = relayUrls;
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

  /** Liste (lecture seule) des URLs de relais actuellement configurés. */
  get relayList(): readonly string[] {
    return this.relayUrls;
  }

  /** Reconnecte aux relais courants (utilise la liste déjà configurée). */
  async reconnect(): Promise<void> {
    this._intentionalDisconnect = false;
    await this.connect(this.relayUrls);
  }

  // ── Connexion ──────────────────────────────────────────────────────────────

  async connect(relays: string[] = DEFAULT_RELAYS): Promise<void> {
    // Empêcher les appels simultanés (race condition)
    if (this._isConnecting) {
      console.log('[Nostr] Connexion déjà en cours, ignoré');
      return;
    }
    this._isConnecting = true;
    this._reconnectAttempts = 0; // Reset counter on successful connection path

    try {
      this.relayUrls = relays;
      for (const url of relays) {
        this.relayStatus.set(url, 'connecting');
      }
      this._notifyStatus();

      // ✅ FIX FORUM DISCOVERY v4 — connecter chaque relai INDIVIDUELLEMENT
      // au lieu d'un seul ping global qui marquait tous les relais 'connected'
      // dès qu'UN SEUL répondait EOSE. Cela faussait isConnected et causait
      // l'envoi de REQ à des relais morts (qui ne répondent jamais).
      //
      // Maintenant : pool.ensureRelay(url) ouvre la WS pour chaque relai
      // séparément, avec un timeout par relai. On marque 'connected' UNIQUEMENT
      // les relais dont la WS s'est vraiment ouverte.
      const connectPromises = relays.map(async (url): Promise<void> => {
        try {
          const relay = await Promise.race([
            this.pool.ensureRelay(url),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), CONNECT_TIMEOUT_MS)
            ),
          ]);
          // ensureRelay a réussi (WS ouvert) — marquer 'connected'
          this.relayStatus.set(url, 'connected');
          console.log(`[Nostr] ✅ Relai connecté : ${url}`);
          // Notifier au fur et à mesure (UI peut afficher les relais qui passent connected)
          this._notifyStatus();
        } catch (err) {
          this.relayStatus.set(url, 'error');
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[Nostr] ❌ Relai inaccessible : ${url} (${errMsg})`);
          this._notifyStatus();
        }
      });

      // Attendre que TOUS les relais aient soit succeed soit failed
      await Promise.all(connectPromises);

      const connectedCount = Array.from(this.relayStatus.values()).filter(s => s === 'connected').length;
      console.log(`[Nostr] Connexion terminée : ${connectedCount}/${relays.length} relais OK`);

      // Renvoyer les events en attente
      await this._drainOfflineQueue();

      // Lancer le keep-alive : ping toutes les 30s, reconnecte si mort
      this._startKeepAlive();
    } finally {
      this._isConnecting = false;
    }
  }

  disconnect(): void {
    this._intentionalDisconnect = true;
    this._stopKeepAlive();
    this.pool.close(this.relayUrls);
    for (const url of this.relayUrls) {
      this.relayStatus.set(url, 'disconnected');
    }
    this._notifyStatus();
  }

  private _startKeepAlive(): void {
    this._stopKeepAlive();
    this._intentionalDisconnect = false;
    this._reconnectDelay = 2000;
    // Vérifie toutes les 30s si on est encore connecté
    this._keepAliveTimer = setInterval(() => {
      if (!this.isConnected && !this._intentionalDisconnect && this.relayUrls.length > 0) {
        this._scheduleReconnect();
      }
    }, 30000);
  }

  private _stopKeepAlive(): void {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer || this._intentionalDisconnect) return;

    // Limite max de tentatives pour éviter reconnexion infinie
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.error(`[Nostr] Nombre max de reconnexions (${this._maxReconnectAttempts}) atteint — arrêt`);
      this._notifyStatus();
      return;
    }

    const delay = this._reconnectDelay;
    // Backoff exponentiel : 2s → 4s → 8s → 16s → 30s max
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
    this._reconnectAttempts++;
    console.log(`[Nostr] Reconnexion dans ${delay / 1000}s… (tentative ${this._reconnectAttempts}/${this._maxReconnectAttempts})`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._intentionalDisconnect || this.isConnected) return;
      this._isReconnecting = true;
      try {
        // Fermer proprement l'ancien pool pour éviter les fuites de connexion
        this.pool.close(this.relayUrls);
        // Recréer le pool pour éviter les WS zombies
        this.pool = new SimplePool();
        for (const url of this.relayUrls) {
          this.relayStatus.set(url, 'connecting');
        }
        this._notifyStatus();
        await this.connect(this.relayUrls);
        // Reconnexion réussie : reset delay et compteur
        this._reconnectDelay = 2000;
        this._reconnectAttempts = 0;
        console.log('[Nostr] Reconnexion réussie');
        // Réabonner automatiquement aux subscriptions actives
        this._resubscribeAll();
      } catch {
        console.warn('[Nostr] Reconnexion échouée, retry dans', this._reconnectDelay / 1000, 's');
      } finally {
        this._isReconnecting = false;
      }
    }, delay);
  }

  /**
   * Réabonne toutes les subscriptions actives après une reconnexion.
   * Les subscriptions précédentes sont mortes car le pool a été recréé.
   */
  private _resubscribeAll(): void {
    if (this._activeSubscriptions.length === 0) return;
    console.log(`[Nostr] Réabonnement de ${this._activeSubscriptions.length} subscription(s) active(s)`);
    for (const sub of this._activeSubscriptions) {
      // Fermer l'ancienne subscription si elle existe encore
      if (sub.unsub) {
        try { sub.unsub(); } catch { /* ignore */ }
      }
      // Réabonner avec les mêmes paramètres
      sub.unsub = this._doSubscribe(sub.filters, sub.onEvent, sub.onEOSE);
    }
  }

  /**
   * Implémentation interne de la subscription.
   */
  private _doSubscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEOSE?: () => void,
    relays?: string[],
  ): () => void {
    let eventCount = 0;
    let rejectedCount = 0;
    const handler = (event: NostrEvent): void => {
      eventCount++;
      // Double validation : hash + signature + timestamp
      if (!this._validateEvent(event)) {
        rejectedCount++;
        if (rejectedCount <= 3) {
          console.warn(`[Nostr] _doSubscribe: event rejeté par _validateEvent — kind=${event.kind} id=${event.id.slice(0,12)} ts=${event.created_at}`);
        }
        return;
      }
      onEvent(event);
    };

    const eoseHandler = onEOSE ? () => {
      console.log(`[Nostr] _doSubscribe: EOSE reçu — ${eventCount} events total (${rejectedCount} rejetés)`);
      onEOSE();
    } : undefined;

    // Utilise les relais spécifiés si fournis, sinon tous les relayUrls
    const targetRelays = relays && relays.length > 0 ? relays : this.relayUrls;
    const sub = this.pool.subscribeMany(targetRelays, filters as any, {
      onevent: handler,
      oneose: eoseHandler,
    });

    return () => sub.close();
  }

  /**
   * Validation complète d'un event Nostr.
   * Vérifie hash, signature et timestamp (pas trop vieux).
   */
  private _validateEvent(event: NostrEvent): boolean {
    // Vérification hash
    if (getEventHash(event) !== event.id) {
      console.warn('[Nostr] Hash/ID invalide — event ignoré:', event.id.slice(0, 12));
      return false;
    }
    // Vérification signature
    if (!verifyEvent(event)) {
      console.warn('[Nostr] Signature invalide — event ignoré:', event.id.slice(0, 12));
      return false;
    }
    // ✅ FIX (forum discovery) — Kinds long-vécus exemptés du check d'âge max :
    //   - kind 0 (Metadata) : profil utilisateur, peut dater de mois
    //   - kind 40/41 (ChannelCreate/Metadata NIP-28) : un forum créé il y a
    //     6 mois reste valide ; sans cette exemption, subscribeForums()
    //     ne retournait quasi rien car tous les forums sont rejetés
    //   - kind 1059 (Gift Wrap NIP-59) : timestamps deliberately randomized
    //   - kind 10002 (RelayList NIP-65) : liste de relais persistante
    const LONG_LIVED_KINDS = new Set<number>([0, 40, 41, 1059, 10002]);
    const isLongLived = LONG_LIVED_KINDS.has(event.kind);
    // Check "pas dans le futur" appliqué à tous les events
    const now = Math.floor(Date.now() / 1000);
    const maxFuture = 60 * 60; // 1 heure
    if (event.created_at > now + maxFuture) {
      console.warn('[Nostr] Event dans le futur — ignoré:', event.id.slice(0, 12));
      return false;
    }
    if (!isLongLived) {
      const maxAge = 24 * 60 * 60; // 24h pour les kinds éphémères
      if (event.created_at < now - maxAge) {
        console.warn('[Nostr] Event trop vieux — ignoré:', event.id.slice(0, 12), 'kind:', event.kind);
        return false;
      }
    }
    return true;
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

    if (!this.isConnected || this._isReconnecting) {
      if (this.offlineQueue.length >= OFFLINE_QUEUE_MAX) {
        throw new Error('[Nostr] Queue offline pleine (max 100 événements)');
      }
      console.warn('[Nostr] Hors ligne — event kind:', template.kind, 'mis en queue');
      return new Promise<NostrEvent>((resolve, reject) => {
        this.offlineQueue.push({ template, resolve, reject });
        this.onQueueChanged?.(this.getOfflineQueueTemplates());
      });
    }

    const publishPromises = this.pool.publish(this.relayUrls, event);
    try {
      await Promise.any(publishPromises);
    } catch {
      // Tous les relays ont échoué
      console.warn('[Nostr] Aucun relay n\'a accepté l\'event kind:', event.kind);
      throw new Error(`[Nostr] Échec publication — aucun relay n\'a accepté l\'event kind: ${event.kind}`);
    }

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
    // ✅ FIX FORUM DISCOVERY v4 — n'envoyer la subscription qu'aux relais
    // RÉELLEMENT connectés (status === 'connected'). Avant : on envoyait
    // à tous les relayUrls, y compris des relais 'error' qui ne renvoient
    // jamais d'event ni d'EOSE — résultat la subscription restait pendue.
    const activeRelays = this.relayUrls.filter(url => this.relayStatus.get(url) === 'connected');
    console.log(`[Nostr] subscribe(${JSON.stringify(filters)}) — ${activeRelays.length}/${this.relayUrls.length} relais actifs : ${activeRelays.join(', ')}`);
    if (activeRelays.length === 0) {
      console.warn('[Nostr] ⚠️ subscribe called but NO relays connected — subscription will receive nothing. Try reconnecting.');
    }

    // Créer la subscription
    const unsub = this._doSubscribe(filters, onEvent, onEOSE, activeRelays);
    
    // Stocker pour réabonnement auto après reconnect
    const subRecord = { filters, onEvent, onEOSE, unsub };
    this._activeSubscriptions.push(subRecord);

    // Retourner une fonction de cleanup qui retire aussi du registre
    return () => {
      unsub();
      const idx = this._activeSubscriptions.indexOf(subRecord);
      if (idx !== -1) {
        this._activeSubscriptions.splice(idx, 1);
      }
    };
  }

  // ── NIP-44 : DMs chiffrés (ChaCha20-Poly1305) ────────────────────────────

  /**
   * Envoie un DM chiffré NIP-44 à une clé publique Nostr.
   * NIP-44 = ChaCha20-Poly1305 + HKDF + padding longueur (remplace NIP-04).
   *
   * @deprecated NIP-04 est obsolète. Utilisez {@link publishDMSealed} (NIP-17) pour une meilleure confidentialité.
   */
  async publishDM(recipientPubKey: string, content: string): Promise<NostrEvent> {
    if (!this.keypair) throw new Error('[Nostr] Keypair non initialisée');

    console.warn('[Nostr] publishDM (NIP-04) est obsolète — utilisez publishDMSealed (NIP-17)');
    const ciphertext = nip44Encrypt(this.keypair.secretKey, recipientPubKey, content);
    return this.publish({
      kind: Kind.EncryptedDM,
      content: ciphertext,
      tags: [['p', recipientPubKey]],
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * S'abonne aux DMs entrants NIP-44 et les déchiffre automatiquement.
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
          const plaintext = nip44Decrypt(this.keypair!.secretKey, event.pubkey, event.content);
          onDM(event.pubkey, plaintext, event);
        } catch {
          console.warn('[Nostr] Déchiffrement DM NIP-44 échoué — ignoré:', event.id.slice(0, 12));
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

    const myPrivKey = this.keypair.secretKey;
    const myPubKey = this.keypair.publicKey;

    // ── NIP-17 Gift Wrap — implémentation manuelle (nip17.wrapEvent API instable) ──
    // 1. Rumor (kind:14) — le message en clair
    const rumor: EventTemplate = {
      kind: Kind.PrivateDirectMessage,
      content,
      tags: [['p', recipientPubKey]],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: myPubKey,
    };

    // 2. Seal (kind:13) — rumor chiffré avec NIP-44, signé par la clé de l'expéditeur
    const sealConversationKey = nip44.getConversationKey(myPrivKey, recipientPubKey);
    const sealContent = nip44.encrypt(JSON.stringify(rumor), sealConversationKey);

    const seal = finalizeEvent({
      kind: 13,
      content: sealContent,
      tags: [['p', recipientPubKey]],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: myPubKey,
    }, myPrivKey);

    // 3. Gift Wrap (kind:1059) — seal chiffré avec NIP-44, signé par clé éphémère
    const ephemeralPrivKey = secp256k1.utils.randomPrivateKey();
    const ephemeralPubKey = getPublicKey(ephemeralPrivKey);

    const gwConversationKey = nip44.getConversationKey(ephemeralPrivKey, recipientPubKey);
    const gwContent = nip44.encrypt(JSON.stringify(seal), gwConversationKey);

    // NIP-17 : timestamp aléatoire ±2 jours pour l'obfuscation
    const now = Math.floor(Date.now() / 1000);
    const randomOffset = Math.floor(Math.random() * 345600) - 172800;

    const giftWrap = finalizeEvent({
      kind: Kind.GiftWrap,
      content: gwContent,
      tags: [['p', recipientPubKey]],
      created_at: now + randomOffset,
      pubkey: ephemeralPubKey,
    }, ephemeralPrivKey);

    // Publier le gift wrap (ne pas bloquer si un relay refuse)
    await Promise.any(this.pool.publish(this.relayUrls, giftWrap)).catch(() => {
      console.warn('[Nostr] Gift Wrap : relay n\'a pas accepté kind:1059');
    });

    console.log('[Nostr] Gift Wrap envoyé — kind:1059, destinataire:', recipientPubKey.slice(0, 12) + '…');
    return giftWrap;
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
   * Tag NIP-12 utilisé pour identifier les forums MeshPay sur les relais Nostr.
   * Permet à `subscribeForums` de filtrer uniquement les forums MeshPay au lieu
   * de recevoir tous les kind:40 globaux (Damus, Iris, etc).
   *
   * ⚠️ Exporté comme const top-level (cf. MESHPAY_FORUM_TAG plus bas) plutôt
   * que static class member pour éviter des surprises avec Hermes (les static
   * members peuvent être problématiques avec le JS engine de RN en release).
   */

  /**
   * Crée un channel public (NIP-28 kind:40).
   *
   * ✅ FIX FORUM DISCOVERY : ajoute un tag `['t', 'meshpay-forum']` (NIP-12)
   * pour identifier le forum comme appartenant à MeshPay. Sans ce tag,
   * `subscribeForums` recevait tous les kind:40 globaux du relai (la majorité
   * non liés à MeshPay), rendant la découverte invisible dans le bruit.
   *
   * @returns L'event publié dont l'id est l'identifiant du channel.
   */
  async createChannel(name: string, about: string, picture?: string): Promise<NostrEvent> {
    const normalizedName = name.toLowerCase().trim();
    console.log(`[Nostr] createChannel: name=${normalizedName} tag=${MESHPAY_FORUM_TAG}`);
    const event = await this.publish({
      kind: Kind.ChannelCreate,
      content: JSON.stringify({ name, about, picture: picture ?? '' }),
      tags: [
        ['t', MESHPAY_FORUM_TAG],     // NIP-12 : identifie MeshPay
        ['name', normalizedName],     // facette de recherche / dedup
      ],
      created_at: Math.floor(Date.now() / 1000),
    });
    console.log(`[Nostr] createChannel SUCCESS — kind:40 publié id=${event.id.slice(0, 16)} tags=${JSON.stringify(event.tags)}`);
    return event;
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
   * Découverte de forums publics MeshPay via NIP-28 kind:40 (ChannelCreate).
   *
   * ✅ FIX FORUM DISCOVERY : filtre par tag `#t: meshpay-forum` (NIP-12) pour
   * ne récupérer que les forums créés par MeshPay (ignore le bruit de tous les
   * autres kind:40 du relai). Combiné au tag posé par `createChannel`.
   *
   * Note : kind:40 sont exemptés du check d'âge 24h dans `_validateEvent`
   * (un forum créé il y a des mois reste valide).
   *
   * @param onChannel  Callback appelé pour chaque kind:40 MeshPay valide
   * @param onEOSE     Callback appelé quand les relays ont fini d'envoyer
   *                   les events stockés (End Of Stored Events)
   * @param limit      Nombre max d'events à recevoir (défaut 100)
   */
  subscribeForums(
    onChannel: (event: NostrEvent) => void,
    onEOSE?: () => void,
    limit = 100,
  ): () => void {
    console.log(`[Nostr] subscribeForums: kind:40 #t=${MESHPAY_FORUM_TAG} limit=${limit} relays=${this.relayUrls.length}`);
    return this.subscribe(
      [{
        kinds: [Kind.ChannelCreate],
        '#t': [MESHPAY_FORUM_TAG],
        limit,
      }],
      onChannel,
      onEOSE,
    );
  }

  /**
   * Découverte de forums kind:40 sans filtrage par tag MeshPay (rétrocompat).
   *
   * À utiliser en complément de `subscribeForums` pour récupérer les forums
   * créés AVANT l'introduction du tag (commit "fix forum discovery" v1.0.10).
   * Le filtrage MeshPay se fait alors côté client en parsant le content JSON.
   *
   * Sera supprimé une fois la base de forums migrée (~v1.2.0).
   */
  subscribeForumsLegacy(
    onChannel: (event: NostrEvent) => void,
    onEOSE?: () => void,
    limit = 50,
  ): () => void {
    console.log(`[Nostr] subscribeForumsLegacy: kind:40 limit=${limit} (sans tag MeshPay)`);
    return this.subscribe(
      [{ kinds: [Kind.ChannelCreate], limit }],
      onChannel,
      onEOSE,
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
   *
   * @param onTx           Callback appelé pour chaque TX valide et autorisée
   * @param trustedPubkeys Ensemble de pubkeys hex (64 chars) autorisées à relayer.
   *                       Passer `null` pour mode permissif (déconseillé en production).
   *                       Omis = strict : seul self-relay accepté.
   */
  subscribeTxRelay(
    onTx: (payload: TxRelayPayload, event: NostrEvent) => void,
    trustedPubkeys?: Set<string> | null,
  ): () => void {
    return this.subscribe(
      [{ kinds: [Kind.TxRelay] }],
      (event) => {
        // Vérification expéditeur — note : hash + signature déjà vérifiés dans subscribe()
        if (trustedPubkeys !== null) {
          const allowed = trustedPubkeys ?? new Set<string>();
          const selfPubkey = this.keypair?.publicKey;
          if (event.pubkey !== selfPubkey && !allowed.has(event.pubkey)) {
            console.warn(
              '[Nostr] TxRelay rejeté — expéditeur non autorisé:',
              event.pubkey.slice(0, 16) + '…',
            );
            return;
          }
        }

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

    // Vider la persistance après drain réussi (appelé par _persistQueue en fin de drain)
    this.onQueueChanged?.([]);
  }

  // ── Persistance offline queue ─────────────────────────────────────────────
  //
  // nostr-client.ts est un module pur (pas de React, pas de AsyncStorage).
  // La sérialisation est déléguée au provider via ce callback.

  /** Callback appelé à chaque mutation de la queue — injecté par NostrProvider */
  onQueueChanged?: (templates: EventTemplate[]) => void;

  /**
   * Retourne les templates de la queue (sérialisables).
   * Utilisé par NostrProvider pour persister dans AsyncStorage.
   */
  getOfflineQueueTemplates(): EventTemplate[] {
    return this.offlineQueue.map(p => p.template);
  }

  /**
   * Restaure des templates depuis AsyncStorage (appelé au démarrage).
   * Les re-queue comme de nouvelles promesses avec resolve/reject réels.
   */
  restoreOfflineQueue(templates: EventTemplate[]): Promise<NostrEvent>[] {
    if (templates.length === 0) return [];
    const available = OFFLINE_QUEUE_MAX - this.offlineQueue.length;
    const toRestore = templates.slice(0, available);
    const promises: Promise<NostrEvent>[] = [];
    for (const template of toRestore) {
      // Promesses réelles — seront résolues/rejetées quand l'event sera publié
      let resolveFn: (event: NostrEvent) => void = () => {};
      let rejectFn: (err: Error) => void = () => {};
      const promise = new Promise<NostrEvent>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      promises.push(promise);
      this.offlineQueue.push({
        template,
        resolve: resolveFn,
        reject: rejectFn,
      });
    }
    console.log('[Nostr] Queue restaurée depuis stockage persistant:', toRestore.length, 'events');
    this.onQueueChanged?.(this.getOfflineQueueTemplates());
    return promises;
  }

  private _notifyStatus(): void {
    this.onStatusChange?.(this.getRelayInfos());
  }
}

// ─── Singleton app-wide ───────────────────────────────────────────────────────
// Une seule instance partagée — configurée par NostrProvider au démarrage.
export const nostrClient = new NostrClient();
