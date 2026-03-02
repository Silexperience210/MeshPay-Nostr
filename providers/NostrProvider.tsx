/**
 * NostrProvider — Contexte React pour le transport Nostr
 *
 * - Auto-connexion quand le wallet est initialisé (clés dérivées NIP-06)
 * - Expose publishDM, subscribeDMs, createChannel, publishChannelMessage,
 *   subscribeChannel, publishTxRelay
 * - Déconnexion propre quand le wallet est supprimé
 * - MQTT reste fonctionnel en parallèle pendant la migration
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import createContextHook from '@nkzw/create-context-hook';
import { useWalletSeed } from '@/providers/WalletSeedProvider';
import {
  nostrClient,
  deriveNostrKeypair,
  DEFAULT_RELAYS,
  type RelayInfo,
  type NostrKeypair,
  type TxRelayPayload,
} from '@/utils/nostr-client';
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

  // ── Channels (NIP-28) ─────────────────────────────────────────────────────
  createChannel: (name: string, about: string, picture?: string) => Promise<NostrEvent>;
  publishChannelMessage: (channelId: string, content: string, replyToId?: string) => Promise<NostrEvent>;
  subscribeChannel: (channelId: string, onMsg: (e: NostrEvent) => void, since?: number) => () => void;

  // ── TX Relay (kind:9001) ──────────────────────────────────────────────────
  publishTxRelay: (payload: TxRelayPayload) => Promise<NostrEvent>;
  subscribeTxRelay: (
    onTx: (payload: TxRelayPayload, event: NostrEvent) => void,
  ) => () => void;

  // ── Accès bas niveau ─────────────────────────────────────────────────────
  publish: (template: { kind: number; content: string; tags: string[][] }) => Promise<NostrEvent>;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export const [NostrContext, useNostr] = createContextHook((): NostrState => {
  const { mnemonic, isInitialized } = useWalletSeed();

  const [npub, setNpub] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [relays, setRelays] = useState<RelayInfo[]>([]);

  // Ref pour éviter les mises à jour d'état après démontage
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
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
          setRelays([]);
        }
      }
      return;
    }

    let cancelled = false;

    const init = async () => {
      try {
        if (mountedRef.current) setIsConnecting(true);

        // Dériver les clés Nostr depuis le même seed BIP39 que le wallet Bitcoin
        const keypair: NostrKeypair = deriveNostrKeypair(mnemonic);
        nostrClient.setKeypair(keypair);

        // Observer les changements d'état des relays
        nostrClient.setOnStatusChange((relayInfos) => {
          if (!cancelled && mountedRef.current) {
            setRelays(relayInfos);
            setIsConnected(relayInfos.some(r => r.status === 'connected'));
          }
        });

        await nostrClient.connect(DEFAULT_RELAYS);

        if (!cancelled && mountedRef.current) {
          setNpub(keypair.npub);
          setPublicKey(keypair.publicKey);
          setIsConnecting(false);
          console.log('[NostrProvider] Connecté —', keypair.npub.slice(0, 16) + '…');
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
  }, [isInitialized, mnemonic]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── DMs ──────────────────────────────────────────────────────────────────

  const publishDM = useCallback(
    (recipientPubKey: string, content: string) =>
      nostrClient.publishDM(recipientPubKey, content),
    [],
  );

  const subscribeDMs = useCallback(
    (onDM: (from: string, content: string, event: NostrEvent) => void) =>
      nostrClient.subscribeDMs(onDM),
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
    isConnected,
    isConnecting,
    relays,
    publishDM,
    subscribeDMs,
    createChannel,
    publishChannelMessage,
    subscribeChannel,
    publishTxRelay,
    subscribeTxRelay,
    publish,
  };
});
