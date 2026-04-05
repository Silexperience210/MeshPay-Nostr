/**
 * useMessages - Hook de gestion des messages et conversations
 * 
 * Remplace: useMessages() - Conversations, envoi messages
 * 
 * Fonctionnalités:
 * - Gestion de l'état des conversations
 * - Envoi de messages avec fallback transport
 * - Réception temps réel des messages
 * - Marquage comme lu/non lu
 * - Persistance SQLite (via services existants)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { hermes } from '../HermesEngine';
import { 
  EventType, 
  Transport, 
  MessageEvent, 
  EventHandler,
  MessageDirection,
} from '../types';
import { EventBuilder } from '../utils/EventBuilder';

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
  direction: MessageDirection;
  transport: Transport;
  status: 'pending' | 'sent' | 'delivered' | 'failed';
}

export interface UseMessagesReturn {
  // ─── State ──────────────────────────────────────────────────────────────────
  conversations: Conversation[];
  isLoading: boolean;
  error: Error | null;
  
  // ─── Actions ────────────────────────────────────────────────────────────────
  /** Envoyer un message à un contact */
  sendMessage: (to: string, content: string, options?: SendMessageOptions) => Promise<void>;
  
  /** Marquer une conversation comme lue */
  markAsRead: (conversationId: string) => void;
  
  /** Charger les messages d'une conversation */
  loadConversation: (conversationId: string) => Promise<Message[]>;
  
  /** Rafraîchir la liste des conversations */
  refreshConversations: () => Promise<void>;
  
  /** Supprimer une conversation */
  deleteConversation: (conversationId: string) => Promise<void>;
  
  // ─── Getters ────────────────────────────────────────────────────────────────
  /** Obtenir une conversation par ID */
  getConversation: (conversationId: string) => Conversation | undefined;
  
  /** Compter les messages non lus totals */
  totalUnread: number;
}

export interface SendMessageOptions {
  contentType?: string;
  /** Forcer un transport spécifique */
  transport?: Transport;
  /** Affichage du nom du contact */
  displayName?: string;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useMessages(): UseMessagesReturn {
  // ─── State ──────────────────────────────────────────────────────────────────
  const [conversations, setConversations] = useState<Conversation[]>([]);
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
  
  // ─── Chargement initial ─────────────────────────────────────────────────────
  useEffect(() => {
    loadConversationsFromStorage();
  }, []);
  
  // ─── Souscription aux événements ────────────────────────────────────────────
  useEffect(() => {
    const unsubscribers: Array<() => void> = [];
    
    // DM reçus
    const dmUnsub = hermes.on(EventType.DM_RECEIVED, ((event: MessageEvent) => {
      if (!isMounted.current) return;
      
      setConversations(prev => {
        const existingIndex = prev.findIndex(c => c.with === event.from);
        
        if (existingIndex >= 0) {
          // Mettre à jour la conversation existante
          const updated = [...prev];
          updated[existingIndex] = {
            ...updated[existingIndex],
            lastMessage: event.payload.content,
            lastMessageAt: event.timestamp,
            unread: updated[existingIndex].unread + 1,
            lastTransport: event.transport,
          };
          // Déplacer en haut de la liste
          const [conversation] = updated.splice(existingIndex, 1);
          return [conversation, ...updated];
        }
        
        // Créer une nouvelle conversation
        return [{
          id: event.from,
          with: event.from,
          lastMessage: event.payload.content,
          lastMessageAt: event.timestamp,
          unread: 1,
          lastTransport: event.transport,
        }, ...prev];
      });
    }) as EventHandler);
    
    unsubscribers.push(dmUnsub);
    
    // DMs envoyés (pour mettre à jour la conversation)
    const dmSentUnsub = hermes.on(EventType.DM_SENT, ((event: MessageEvent) => {
      if (!isMounted.current) return;
      
      setConversations(prev => {
        const existingIndex = prev.findIndex(c => c.with === event.to);
        
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = {
            ...updated[existingIndex],
            lastMessage: event.payload.content,
            lastMessageAt: event.timestamp,
            lastTransport: event.transport,
          };
          const [conversation] = updated.splice(existingIndex, 1);
          return [conversation, ...updated];
        }
        
        return prev;
      });
    }) as EventHandler);
    
    unsubscribers.push(dmSentUnsub);
    
    // Messages de channel
    const channelUnsub = hermes.on(EventType.CHANNEL_MSG_RECEIVED, ((event: MessageEvent) => {
      if (!isMounted.current) return;
      
      // Pour les messages de channel, on utilise le nom du channel comme ID
      const channelId = event.payload.channelName || event.to || 'general';
      
      setConversations(prev => {
        const existingIndex = prev.findIndex(c => c.with === channelId);
        
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = {
            ...updated[existingIndex],
            lastMessage: event.payload.content,
            lastMessageAt: event.timestamp,
            unread: updated[existingIndex].unread + 1,
            lastTransport: event.transport,
          };
          const [conversation] = updated.splice(existingIndex, 1);
          return [conversation, ...updated];
        }
        
        return [{
          id: channelId,
          with: channelId,
          displayName: `Channel: ${channelId}`,
          lastMessage: event.payload.content,
          lastMessageAt: event.timestamp,
          unread: 1,
          lastTransport: event.transport,
        }, ...prev];
      });
    }) as EventHandler);
    
    unsubscribers.push(channelUnsub);
    
    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, []);
  
  // ─── Actions ────────────────────────────────────────────────────────────────
  
  const sendMessage = useCallback(async (
    to: string, 
    content: string, 
    options?: SendMessageOptions
  ): Promise<void> => {
    setIsLoading(true);
    setError(null);
    
    try {
      const event = EventBuilder.dm()
        .to(to)
        .content(content, options?.contentType || 'text')
        .build();
      
      const preferredTransport = options?.transport;
      
      if (preferredTransport) {
        // Transport spécifié
        const adapter = hermes.getAdapter(preferredTransport);
        if (!adapter?.isConnected) {
          throw new Error(`Transport ${preferredTransport} non disponible`);
        }
        await hermes.emit(event, preferredTransport);
      } else {
        // Auto-sélection avec fallback
        const nostrAdapter = hermes.getAdapter(Transport.NOSTR);
        if (nostrAdapter?.isConnected) {
          await hermes.emit(event, Transport.NOSTR);
        } else {
          const loRaAdapter = hermes.getAdapter(Transport.LORA);
          if (loRaAdapter?.isConnected) {
            await hermes.emit(event, Transport.LORA);
          } else {
            throw new Error('Aucun transport disponible');
          }
        }
      }
      
      // Mettre à jour l'UI localement
      setConversations(prev => {
        const existingIndex = prev.findIndex(c => c.with === to);
        
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = {
            ...updated[existingIndex],
            lastMessage: content,
            lastMessageAt: Date.now(),
            lastTransport: preferredTransport || Transport.NOSTR,
          };
          const [conversation] = updated.splice(existingIndex, 1);
          return [conversation, ...updated];
        }
        
        return [{
          id: to,
          with: to,
          displayName: options?.displayName,
          lastMessage: content,
          lastMessageAt: Date.now(),
          unread: 0,
          lastTransport: preferredTransport || Transport.NOSTR,
        }, ...prev];
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
  
  const markAsRead = useCallback((conversationId: string): void => {
    setConversations(prev => 
      prev.map(c => 
        c.id === conversationId 
          ? { ...c, unread: 0 } 
          : c
      )
    );
  }, []);
  
  const loadConversation = useCallback(async (conversationId: string): Promise<Message[]> => {
    // TODO: Intégrer avec SQLite via database.ts
    // Pour l'instant, retourne un tableau vide
    // Le service de persistence gérera le stockage des messages
    return [];
  }, []);
  
  const loadConversationsFromStorage = useCallback(async (): Promise<void> => {
    // TODO: Charger depuis SQLite
    // Pour l'instant, les conversations sont gérées en mémoire
  }, []);
  
  const refreshConversations = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      await loadConversationsFromStorage();
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
      }
    }
  }, [loadConversationsFromStorage]);
  
  const deleteConversation = useCallback(async (conversationId: string): Promise<void> => {
    setConversations(prev => prev.filter(c => c.id !== conversationId));
    // TODO: Supprimer aussi les messages associés de SQLite
  }, []);
  
  const getConversation = useCallback((conversationId: string): Conversation | undefined => {
    return conversations.find(c => c.id === conversationId);
  }, [conversations]);
  
  const totalUnread = conversations.reduce((sum, c) => sum + c.unread, 0);
  
  // ─── Return ─────────────────────────────────────────────────────────────────
  
  return {
    conversations,
    isLoading,
    error,
    sendMessage,
    markAsRead,
    loadConversation,
    refreshConversations,
    deleteConversation,
    getConversation,
    totalUnread,
  };
}

export default useMessages;
