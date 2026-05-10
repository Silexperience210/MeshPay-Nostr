/**
 * @deprecated Utilisez useMessages() ou messageService de '@/engine' à la place.
 * Ce provider sera supprimé dans la v4.0.
 * 
 * MessagingBusProvider — Contexte React pour le bus de messagerie unifié
 *
 * Transport Nostr-only (Phase 8 — MQTT supprimé) :
 *   - Nostr connecté → messages envoyés via Nostr (décentralisé)
 *   - Nostr absent   → erreur explicite
 *
 * LoRa bridge : BleProvider peut republier un payload LoRa sur Nostr.
 * 
 * Migration: Remplacez `import { useMessagingBus } from '@/providers/MessagingBusProvider'`
 * par `import { useMessages } from '@/engine'` ou `import { messageService } from '@/engine'`
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import createContextHook from '@nkzw/create-context-hook';
import { useNostr } from '@/providers/NostrProvider';
import { useWalletStore } from '@/stores/walletStore';
import { messagingBus, type BusMessage, type BusMessageHandler, type BusStatus, type Transport } from '@/utils/messaging-bus';

// ─── Interface publique ───────────────────────────────────────────────────────

export interface MessagingBusState {
  /** État des transports */
  status: BusStatus;
  /** Transport actuellement préféré */
  preferredTransport: 'nostr' | 'none';

  /**
   * Envoie un DM via Nostr.
   */
  sendDM: (params: {
    toNodeId: string;
    toNostrPubkey: string;
    content: string;
  }) => Promise<Transport>;

  /**
   * Envoie un message de channel via Nostr (NIP-28).
   */
  sendChannelMessage: (params: {
    channelId: string;
    content: string;
    nostrChannelId?: string;
  }) => Promise<Transport>;

  /**
   * Abonne un handler aux messages entrants.
   * Retourne une fonction de désabonnement.
   */
  subscribe: (handler: BusMessageHandler) => () => void;

  /**
   * Bridge explicite : republier un payload LoRa sur Nostr.
   * Appelé par BleProvider quand un message LoRa est reçu.
   */
  bridgeLoraToNostr: (rawPayload: string) => Promise<void>;

  /** Dernier message reçu — pour les composants réactifs */
  lastMessage: BusMessage | null;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export const [MessagingBusContext, useMessagingBus] = createContextHook((): MessagingBusState => {
  const { isConnected: nostrConnected, publicKey: nostrPubkey } = useNostr();
  const walletInfo = useWalletStore((s) => s.walletInfo);

  const [status, setStatus] = useState<BusStatus>({
    nostr: 'disconnected',
    preferred: 'none',
  });
  const [lastMessage, setLastMessage] = useState<BusMessage | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Synchroniser l'identité locale dans le bus ────────────────────────────

  useEffect(() => {
    const nodeId = walletInfo?.firstReceiveAddress
      ? `MESH-${walletInfo.firstReceiveAddress.slice(2, 6).toUpperCase()}`
      : '';

    if (nodeId && nostrPubkey) {
      messagingBus.setLocalIdentity(nodeId, nostrPubkey);
      console.log('[BusProvider] Identité configurée:', nodeId, nostrPubkey.slice(0, 16) + '…');
    }
  }, [walletInfo, nostrPubkey]);

  // ── Mettre à jour le statut du bus ────────────────────────────────────────

  useEffect(() => {
    if (!mountedRef.current) return;
    setStatus({
      nostr: nostrConnected ? 'connected' : 'disconnected',
      preferred: nostrConnected ? 'nostr' : 'none',
    });

    // ✅ FIX: Quand Nostr reconnecte, le SimplePool est recréé → les anciennes
    // subscriptions (subscribeDMs, subscribeDMsSealed, subscribeTxRelay) sont mortes.
    // On doit redémarrer les listeners du bus pour recréer les subs sur le nouveau pool.
    if (nostrConnected) {
      messagingBus.restartListenersIfNeeded();
    }
  }, [nostrConnected]);

  // ── S'abonner aux messages entrants pour maintenir `lastMessage` ──────────

  useEffect(() => {
    const unsub = messagingBus.subscribe((msg) => {
      if (mountedRef.current) {
        setLastMessage(msg);
      }
    });
    return unsub;
  }, []);

  // ── API publique ──────────────────────────────────────────────────────────

  const sendDM = useCallback(
    (params: {
      toNodeId: string;
      toNostrPubkey: string;
      content: string;
    }) => messagingBus.sendDM(params),
    [],
  );

  const sendChannelMessage = useCallback(
    (params: {
      channelId: string;
      content: string;
      nostrChannelId?: string;
    }) => messagingBus.sendChannelMessage(params),
    [],
  );

  const subscribe = useCallback(
    (handler: BusMessageHandler) => messagingBus.subscribe(handler),
    [],
  );

  const bridgeLoraToNostr = useCallback(
    (rawPayload: string) => messagingBus.bridgeLoraToNostr(rawPayload),
    [],
  );

  return {
    status,
    preferredTransport: messagingBus.preferredTransport,
    sendDM,
    sendChannelMessage,
    subscribe,
    bridgeLoraToNostr,
    lastMessage,
  };
});
