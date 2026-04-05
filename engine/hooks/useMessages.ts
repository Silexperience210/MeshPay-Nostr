/**
 * useMessages - Hook React pour la gestion des messages via MessageService
 * 
 * Remplace: useMessages() ancien basé sur messaging-bus
 * 
 * Fonctionnalités:
 * - Gestion de l'état des conversations
 * - Envoi de messages via MessageService
 * - Réception temps réel via Hermès Engine
 * - Historique via EventStore
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { messageService, DirectMessage, ChannelMessage } from '../services/MessageService';
import { Transport } from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  /** Identifiant du contact (npub ou nodeId) */
  with: string;
  /** Nom affiché du contact */
  displayName?: string;
  /** Dernier message reçu/envoyé */
  lastMessage: string;
  /** Timestamp du dernier message */
  lastMessageAt: number;
  /** Nombre de messages non lus */
  unread: number;
  /** Transport utilisé pour la dernière communication */
  lastTransport?: Transport;
}

export interface Message {
  id: string;
  conversationId: string;
  from: string;
  to: string;
  content: string;
  contentType: string;
  timestamp: number;
  direction: 'inbound' | 'outbound';
  transport: Transport;
  status: 'pending' | 'sent' | 'delivered' | 'failed';
}

export interface SendMessageOptions {
  contentType?: string;
  /** Forcer un transport spécifique */
  transport?: Transport;
  /** Affichage du nom du contact */
  displayName?: string;
}

export interface UseMessagesReturn {
  // ─── State ──────────────────────────────────────────────────────────────────
  conversations: Map<string, DirectMessage[]>;
  isLoading: boolean;
  error: Error | null;

  // ─── Actions ────────────────────────────────────────────────────────────────
  /** Envoyer un DM à un contact */
  sendDM: (toNodeId: string, toPubkey: string, content: string) => Promise<void>;
  /** Envoyer un message dans un channel */
  sendChannelMessage: (channelId: string, content: string) => Promise<void>;

  // ─── Historique ─────────────────────────────────────────────────────────────
  /** Charger l'historique d'une conversation */
  loadDMHistory: (peerId: string, limit?: number) => Promise<DirectMessage[]>;
  /** Charger l'historique d'un channel */
  loadChannelHistory: (channelId: string, limit?: number) => Promise<ChannelMessage[]>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useMessages(): UseMessagesReturn {
  // ─── State ──────────────────────────────────────────────────────────────────
  const [conversations, setConversations] = useState<Map<string, DirectMessage[]>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Ref pour éviter les fuites mémoire
  const isMounted = useRef(true);

  // ─── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  // ─── Souscription aux événements ────────────────────────────────────────────
  useEffect(() => {
    // S'abonner aux DMs entrants
    const unsub = messageService.onDM((msg) => {
      if (!isMounted.current) return;

      setConversations(prev => {
        // Déterminer l'ID de la conversation (peer)
        const peerId = msg.from === 'local' ? msg.to : msg.from;
        const current = prev.get(peerId) ?? [];
        const next = new Map(prev);
        next.set(peerId, [...current, msg]);
        return next;
      });
    });

    return unsub;
  }, []);

  // ─── Actions ────────────────────────────────────────────────────────────────

  const sendDM = useCallback(async (
    toNodeId: string,
    toPubkey: string,
    content: string
  ): Promise<void> => {
    setIsLoading(true);
    setError(null);

    try {
      await messageService.sendDM(toNodeId, toPubkey, content);

      // Mettre à jour l'état local
      setConversations(prev => {
        const current = prev.get(toNodeId) ?? [];
        const msg: DirectMessage = {
          id: `local-${Date.now()}`,
          from: 'local',
          to: toNodeId,
          content,
          timestamp: Date.now(),
          transport: 'nostr',
          encryption: 'nip44',
        };
        const next = new Map(prev);
        next.set(toNodeId, [...current, msg]);
        return next;
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      throw error;
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
      }
    }
  }, []);

  const sendChannelMessage = useCallback(async (
    channelId: string,
    content: string
  ): Promise<void> => {
    setIsLoading(true);
    setError(null);

    try {
      await messageService.sendChannelMessage(channelId, content);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      throw error;
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // ─── Historique ─────────────────────────────────────────────────────────────

  const loadDMHistory = useCallback(async (
    peerId: string,
    limit = 50
  ): Promise<DirectMessage[]> => {
    setIsLoading(true);
    try {
      const history = await messageService.getDMHistory(peerId, limit);
      setConversations(prev => {
        const next = new Map(prev);
        next.set(peerId, history);
        return next;
      });
      return history;
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
      }
    }
  }, []);

  const loadChannelHistory = useCallback(async (
    channelId: string,
    limit = 50
  ): Promise<ChannelMessage[]> => {
    setIsLoading(true);
    try {
      const history = await messageService.getChannelHistory(channelId, limit);
      return history;
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // ─── Return ─────────────────────────────────────────────────────────────────

  return {
    conversations,
    isLoading,
    error,
    sendDM,
    sendChannelMessage,
    loadDMHistory,
    loadChannelHistory,
  };
}

export default useMessages;
