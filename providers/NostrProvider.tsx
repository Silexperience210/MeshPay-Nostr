/**
 * NostrProvider — Contexte React pour le transport Nostr
 *
 * - Auto-connexion quand le wallet est initialisé (clés dérivées NIP-06)
 * - Expose publishDM, subscribeDMs, createChannel, publishChannelMessage,
 *   subscribeChannel, publishTxRelay
 * - Déconnexion propre quand le wallet est supprimé
 * - MQTT reste fonctionnel en parallèle pendant la migration
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import createContextHook from '@nkzw/create-context-hook';
import { useWalletStore } from '@/stores/walletStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  nostrClient,
  deriveNostrKeypair,
  type RelayInfo,
  type NostrKeypair,
  type TxRelayPayload,
  type PresencePayload,
} from '@/utils/nostr-client';
import type { EventTemplate } from 'nostr-tools';

const OFFLINE_QUEUE_STORAGE_KEY = 'nostr_offline_queue_v1';
import { deriveMeshIdentity } from '@/utils/identity';
import type { Event as NostrEvent } from 'nostr-tools';

// ─── Interface publique ───────────────────────────────────────────────────────

export interface NostrState {
  /** Clé publique bech32 de l'utilisateur (npub1…) */
  npub: string | null;
  /** Clé publique hex 64 chars (pour les tags NIP-04) */
  publicKey: string | null;
  /** Au moins un relay est connecté */
  isConnected: boolean;
  /** Connexion en cours */
  isConnecting: boolean;
  /** État par relay */
  relays: RelayInfo[];

  // ── DMs (NIP-04) ──────────────────────────────────────────────────────────
  publishDM: (recipientPubKey: string, content: string) => Promise<NostrEvent>;
  subscribeDMs: (
    onDM: (from: string, content: string, event: NostrEvent) => void,
  ) => () => void;

  // ── DMs scellés (NIP-17 Gift Wrap) ────────────────────────────────────────
  /** Envoie un DM NIP-17 (expéditeur masqué, chiffrement NIP-44). */
  publishDMSealed: (recipientPubKey: string, content: string) => Promise<NostrEvent>;
  /** S'abonne aux DMs NIP-17 — déchiffre automatiquement les gift wraps. */
  subscribeDMsSealed: (
    onDM: (from: string, content: string, event: NostrEvent) => void,
  ) => () => void;

  // ── Channels (NIP-28) ─────────────────────────────────────────────────────
  createChannel: (name: string, about: string, picture?: string) => Promise<NostrEvent>;
  publishChannelMessage: (channelId: string, content: string, replyToId?: string) => Promise<NostrEvent>;
  subscribeChannel: (channelId: string, onMsg: (e: NostrEvent) => void, since?: number) => () => void;

  // ── TX Relay (kind:9001) ──────────────────────────────────────────────────
  publishTxRelay: (payload: TxRelayPayload) => Promise<NostrEvent>;
  subscribeTxRelay: (
    onTx: (payload: TxRelayPayload, event: NostrEvent) => void,
  ) => () => void;

  // ── Découverte / Présence ─────────────────────────────────────────────────
  /** NodeId MeshCore dérivé du mnemonic ex: "MESH-A7F2" (null si wallet non init) */
  nodeId: string | null;
  /** Publie une présence kind:9001 type=presence (coordonnées GPS optionnelles). */
  publishPresence: (nodeId: string, lat?: number, lng?: number) => Promise<NostrEvent>;
  /** S'abonne aux présences des pairs MeshPay sur Nostr. */
  subscribePresence: (
    onPresence: (payload: PresencePayload, event: NostrEvent) => void,
  ) => () => void;

  // ── Accès bas niveau ─────────────────────────────────────────────────────
  publish: (template: { kind: number; content: string; tags: string[][] }) => Promise<NostrEvent>;
  /** Reconnecte aux relays actifs (à appeler après modification de la liste) */
  reconnectRelays: () => Promise<void>;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export const [NostrContext, useNostr] = createContextHook((): NostrState => {
  const mnemonic = useWalletStore((s) => s.mnemonic);
  const isInitialized = useWalletStore((s) => s.isInitialized);
  const getActiveRelayUrls = useSettingsStore((s) => s.getActiveRelayUrls);

  const [npub, setNpub] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [relays, setRelays] = useState<RelayInfo[]>([]);

  // Mémoriser le keypair pour éviter de le régénérer à chaque render
  const keypair = useMemo(() => {
    if (!mnemonic) return null;
    try {
      return deriveNostrKeypair(mnemonic);
    } catch (err) {
      console.error('[NostrProvider] Échec dérivation keypair:', err);
      return null;
    }
  }, [mnemonic]);

  // Ref pour éviter les mises à jour d'état après démontage
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Persistance offline queue ─────────────────────────────────────────────

  useEffect(() => {
    // Restaurer la queue depuis AsyncStorage au montage
    AsyncStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY).then((raw) => {
      if (!raw) return;
      try {
        const templates = JSON.parse(raw) as EventTemplate[];
        if (Array.isArray(templates) && templates.length > 0) {
          nostrClient.restoreOfflineQueue(templates);
        }
      } catch {
        console.warn('[NostrProvider] Queue persistée invalide — ignorée');
      }
    }).catch(() => {});

    // Brancher le callback de persistance sur le client
    nostrClient.onQueueChanged = (templates) => {
      if (templates.length === 0) {
        AsyncStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY).catch(() => {});
      } else {
        AsyncStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(templates)).catch(() => {});
      }
    };

    return () => {
      nostrClient.onQueueChanged = undefined;
    };
  }, []);

  // ── Auto-connexion / déconnexion ─────────────────────────────────────────

  useEffect(() => {
    if (!isInitialized || !mnemonic) {
      // Wallet supprimé ou non initialisé → déconnecter
      if (isConnected || isConnecting) {
        nostrClient.disconnect();
        if (mountedRef.current) {
          setIsConnected(false);
          setIsConnecting(false);
          setNpub(null);
          setPublicKey(null);
          setNodeId(null);
          setRelays([]);
        }
      }
      return;
    }

    let cancelled = false;

    const init = async () => {
      try {
        if (mountedRef.current) setIsConnecting(true);

        if (!keypair) {
          throw new Error('[NostrProvider] Keypair non disponible');
        }
        nostrClient.setKeypair(keypair);

        // Observer les changements d'état des relays
        nostrClient.setOnStatusChange((relayInfos) => {
          if (!cancelled && mountedRef.current) {
            setRelays(relayInfos);
            setIsConnected(relayInfos.some(r => r.status === 'connected'));
          }
        });

        await nostrClient.connect(getActiveRelayUrls());

        if (!cancelled && mountedRef.current) {
          setNpub(keypair.npub);
          setPublicKey(keypair.publicKey);
          setIsConnecting(false);
          console.log('[NostrProvider] Connecté —', keypair.npub.slice(0, 16) + '…');

          // Publier les métadonnées kind:0 (découverte passive — NIP-01)
          try {
            const meshId = deriveMeshIdentity(mnemonic);
            setNodeId(meshId.nodeId);
            await nostrClient.publishMetadata(meshId.nodeId, meshId.displayName ?? meshId.nodeId);
            console.log('[NostrProvider] Métadonnées kind:0 publiées — nodeId:', meshId.nodeId);
          } catch (metaErr) {
            console.warn('[NostrProvider] Erreur publication kind:0:', metaErr);
          }
        }
      } catch (err) {
        console.error('[NostrProvider] Erreur initialisation:', err);
        if (!cancelled && mountedRef.current) {
          setIsConnecting(false);
        }
      }
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [isInitialized, mnemonic, keypair, getActiveRelayUrls]);

  // ── DMs ──────────────────────────────────────────────────────────────────

  const publishDM = useCallback(
    (recipientPubKey: string, content: string) => {
      if (!nostrClient.isConnected) {
        return Promise.reject(new Error('[Nostr] Non connecté — impossible d\'envoyer le DM'));
      }
      return nostrClient.publishDM(recipientPubKey, content);
    },
    [],
  );

  const subscribeDMs = useCallback(
    (onDM: (from: string, content: string, event: NostrEvent) => void) =>
      nostrClient.subscribeDMs(onDM),
    [],
  );

  // ── DMs scellés (NIP-17) ─────────────────────────────────────────────────

  const publishDMSealed = useCallback(
    (recipientPubKey: string, content: string) => {
      if (!nostrClient.isConnected) {
        return Promise.reject(new Error('[Nostr] Non connecté — impossible d\'envoyer le DM scellé'));
      }
      return nostrClient.publishDMSealed(recipientPubKey, content);
    },
    [],
  );

  const subscribeDMsSealed = useCallback(
    (onDM: (from: string, content: string, event: NostrEvent) => void) =>
      nostrClient.subscribeDMsSealed(onDM),
    [],
  );

  // ── Channels ─────────────────────────────────────────────────────────────

  const createChannel = useCallback(
    (name: string, about: string, picture?: string) =>
      nostrClient.createChannel(name, about, picture),
    [],
  );

  const publishChannelMessage = useCallback(
    (channelId: string, content: string, replyToId?: string) =>
      nostrClient.publishChannelMessage(channelId, content, replyToId),
    [],
  );

  const subscribeChannel = useCallback(
    (channelId: string, onMsg: (e: NostrEvent) => void, since?: number) =>
      nostrClient.subscribeChannel(channelId, onMsg, since),
    [],
  );

  // ── Présence / Découverte ─────────────────────────────────────────────────

  const publishPresence = useCallback(
    (nId: string, lat?: number, lng?: number) =>
      nostrClient.publishPresence(nId, lat, lng),
    [],
  );

  const subscribePresence = useCallback(
    (onPresence: (payload: PresencePayload, event: NostrEvent) => void) =>
      nostrClient.subscribePresence(onPresence),
    [],
  );

  // ── TX Relay ─────────────────────────────────────────────────────────────

  const publishTxRelay = useCallback(
    (payload: TxRelayPayload) => nostrClient.publishTxRelay(payload),
    [],
  );

  const subscribeTxRelay = useCallback(
    (onTx: (payload: TxRelayPayload, event: NostrEvent) => void) =>
      nostrClient.subscribeTxRelay(onTx),
    [],
  );

  // ── Reconnexion manuelle (après changement de relay list) ────────────────

  const reconnectRelays = useCallback(async () => {
    if (!isInitialized || !mnemonic) return;
    try {
      if (mountedRef.current) setIsConnecting(true);
      await nostrClient.connect(getActiveRelayUrls());
      if (mountedRef.current) setIsConnecting(false);
    } catch (err) {
      console.warn('[NostrProvider] reconnectRelays error:', err);
      if (mountedRef.current) setIsConnecting(false);
    }
  }, [isInitialized, mnemonic, getActiveRelayUrls]);

  // ── Publish bas niveau ───────────────────────────────────────────────────

  const publish = useCallback(
    (template: { kind: number; content: string; tags: string[][] }) =>
      nostrClient.publish({
        ...template,
        created_at: Math.floor(Date.now() / 1000),
      }),
    [],
  );

  return {
    npub,
    publicKey,
    nodeId,
    isConnected,
    isConnecting,
    relays,
    publishDM,
    subscribeDMs,
    publishDMSealed,
    subscribeDMsSealed,
    createChannel,
    publishChannelMessage,
    subscribeChannel,
    publishTxRelay,
    subscribeTxRelay,
    publishPresence,
    subscribePresence,
    publish,
    reconnectRelays,
  };
});
