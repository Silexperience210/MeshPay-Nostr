/**
 * TxRelayProvider — Contexte React pour le relay de transactions via Nostr
 *
 * Deux rôles selon l'état du réseau :
 *
 *  1. GATEWAY (si Nostr connecté + internet)
 *     → écoute les kind:9001 entrants
 *     → broadcast les Bitcoin TX via mempool.space
 *     → acquitte les tokens Cashu
 *     → publie les confirmations
 *
 *  2. CLIENT (si hors ligne ou sans Nostr)
 *     → sendBitcoinTxViaRelay() : publie sur Nostr et attend confirmation
 *     → sendCashuViaRelay()     : publie token sur Nostr (best-effort)
 *     → tracks les relays en cours (pendingRelays)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import createContextHook from '@nkzw/create-context-hook';
import { useNostr } from '@/providers/NostrProvider';
import {
  TxRelayGateway,
  sendBitcoinTxViaNostr,
  sendCashuTokenViaNostr,
  isTxAlreadyKnown,
  type PendingRelay,
  type RelayConfirmation,
} from '@/utils/tx-relay';
import { nostrClient } from '@/utils/nostr-client';

// ─── Interface publique ───────────────────────────────────────────────────────

export interface TxRelayState {
  /** Ce nœud agit-il comme gateway pour les autres ? */
  isGateway: boolean;

  /** Demandes de relay en cours depuis cet appareil */
  pendingRelays: PendingRelay[];

  /** Statistiques du gateway (si isGateway) */
  gatewayStats: {
    relayedCount: number;
    errorCount: number;
  };

  /**
   * Envoie une transaction Bitcoin via un gateway Nostr.
   * Résout avec txid quand broadcastée, rejette en cas d'erreur ou timeout.
   */
  sendBitcoinTxViaRelay: (txHex: string, timeoutMs?: number) => Promise<RelayConfirmation>;

  /**
   * Envoie un token Cashu via un gateway Nostr.
   * Best-effort — résout même sans ack (token toujours valide en cas de timeout).
   */
  sendCashuViaRelay: (token: string, targetMint?: string) => Promise<RelayConfirmation>;

  /** Vide les relays terminés (confirmés ou échoués) */
  clearCompletedRelays: () => void;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export const [TxRelayContext, useTxRelay] = createContextHook((): TxRelayState => {
  const { isConnected: nostrConnected } = useNostr();

  const [isGateway, setIsGateway] = useState(false);
  const [pendingRelays, setPendingRelays] = useState<PendingRelay[]>([]);
  const [gatewayStats, setGatewayStats] = useState({ relayedCount: 0, errorCount: 0 });

  const gatewayRef = useRef<TxRelayGateway | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Gestion du gateway ────────────────────────────────────────────────────

  useEffect(() => {
    if (nostrConnected) {
      // Démarrer le gateway quand Nostr est connecté
      const gateway = new TxRelayGateway(nostrClient);
      gateway.start();
      gatewayRef.current = gateway;
      if (mountedRef.current) setIsGateway(true);
      console.log('[TxRelayProvider] Gateway démarrée');

      // Polling léger des stats (toutes les 10s)
      const statsInterval = setInterval(() => {
        if (mountedRef.current && gatewayRef.current) {
          setGatewayStats({
            relayedCount: gatewayRef.current.relayedCount,
            errorCount: gatewayRef.current.errorCount,
          });
        }
      }, 10_000);

      return () => {
        clearInterval(statsInterval);
        gateway.stop();
        gatewayRef.current = null;
        if (mountedRef.current) {
          setIsGateway(false);
          setGatewayStats({ relayedCount: 0, errorCount: 0 });
        }
      };
    }
  }, [nostrConnected]);

  // ── sendBitcoinTxViaRelay ─────────────────────────────────────────────────

  const sendBitcoinTxViaRelay = useCallback(async (
    txHex: string,
    timeoutMs?: number,
  ): Promise<RelayConfirmation> => {
    const relayId = `btc-${Date.now().toString(36)}`;

    // Enregistrer la demande comme "pending"
    const pending: PendingRelay = {
      eventId: relayId,
      type: 'bitcoin_tx',
      data: txHex.slice(0, 32) + '…', // tronquer pour ne pas stocker la TX complète en state
      sentAt: Date.now(),
      status: 'pending',
    };

    if (mountedRef.current) {
      setPendingRelays(prev => [...prev, pending]);
    }

    try {
      const result = await sendBitcoinTxViaNostr(txHex, { timeoutMs });

      if (mountedRef.current) {
        setPendingRelays(prev =>
          prev.map(r => r.eventId === relayId
            ? { ...r, status: 'confirmed', txid: result.txid }
            : r
          )
        );
      }

      return result;

    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);

      // TX déjà dans la mempool = succès silencieux
      if (err instanceof Error && isTxAlreadyKnown(err)) {
        console.log('[TxRelayProvider] TX déjà connue du réseau — relay considéré réussi');
        if (mountedRef.current) {
          setPendingRelays(prev =>
            prev.map(r => r.eventId === relayId
              ? { ...r, status: 'confirmed' }
              : r
            )
          );
        }
        return {
          success: true,
          gatewayPubkey: 'network',
          originalEventId: relayId,
        };
      }

      if (mountedRef.current) {
        setPendingRelays(prev =>
          prev.map(r => r.eventId === relayId
            ? { ...r, status: 'failed', error }
            : r
          )
        );
      }

      throw err;
    }
  }, []);

  // ── sendCashuViaRelay ─────────────────────────────────────────────────────

  const sendCashuViaRelay = useCallback(async (
    token: string,
    targetMint?: string,
  ): Promise<RelayConfirmation> => {
    const relayId = `cashu-${Date.now().toString(36)}`;

    const pending: PendingRelay = {
      eventId: relayId,
      type: 'cashu_token',
      data: token.slice(0, 32) + '…',
      sentAt: Date.now(),
      status: 'pending',
    };

    if (mountedRef.current) {
      setPendingRelays(prev => [...prev, pending]);
    }

    const result = await sendCashuTokenViaNostr(token, targetMint);

    if (mountedRef.current) {
      setPendingRelays(prev =>
        prev.map(r => r.eventId === relayId
          ? { ...r, status: result.success ? 'confirmed' : 'failed', error: result.error }
          : r
        )
      );
    }

    return result;
  }, []);

  // ── clearCompletedRelays ──────────────────────────────────────────────────

  const clearCompletedRelays = useCallback(() => {
    setPendingRelays(prev => prev.filter(r => r.status === 'pending'));
  }, []);

  return {
    isGateway,
    pendingRelays,
    gatewayStats,
    sendBitcoinTxViaRelay,
    sendCashuViaRelay,
    clearCompletedRelays,
  };
});
