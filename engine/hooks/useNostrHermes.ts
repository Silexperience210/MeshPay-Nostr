/**
 * useNostrHermes - Hook de remplacement pour useNostr() legacy
 * 
 * Phase 3.1 de la migration Hermès Engine:
 * Remplace le NostrProvider legacy par une API utilisant exclusivement Hermès Engine.
 * 
 * @example
 * ```tsx
 * import { useNostrHermes } from '@/engine/hooks';
 * 
 * function ChatScreen() {
 *   const { isConnected, publicKey, connect, disconnect, publishDM, subscribeDMs } = useNostrHermes();
 *   
 *   useEffect(() => {
 *     if (!isConnected) {
 *       connect();
 *     }
 *   }, [isConnected, connect]);
 *   
 *   useEffect(() => {
 *     const unsubscribe = subscribeDMs((from, content) => {
 *       console.log('DM from', from, ':', content);
 *     });
 *     return unsubscribe;
 *   }, [subscribeDMs]);
 *   
 *   const handleSend = async (to: string, message: string) => {
 *     await publishDM(to, message);
 *   };
 *   
 *   // ...
 * }
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { hermes } from '../HermesEngine';
import { EventType, Transport, HermesEvent, EventHandler } from '../types';
import { useWalletStore } from '@/stores/walletStore';

// Relays par défaut (synchronisés avec NostrAdapter)
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseNostrHermesReturn {
  /** État de connexion au réseau Nostr */
  isConnected: boolean;
  /** Clé publique Nostr (hex) du wallet connecté */
  publicKey: string | null;
  /** Liste des relays connectés */
  relays: string[];
  
  /** 
   * Connecter au réseau Nostr
   * @param customRelays - Relays personnalisés (optionnel, utilise les relays par défaut si non spécifié)
   */
  connect: (customRelays?: string[]) => Promise<void>;
  
  /** Déconnecter du réseau Nostr */
  disconnect: () => Promise<void>;
  
  /**
   * Publier un DM (Direct Message)
   * @param toPubkey - Clé publique du destinataire (hex ou npub)
   * @param content - Contenu du message (sera chiffré)
   */
  publishDM: (toPubkey: string, content: string) => Promise<void>;
  
  /**
   * Publier un message dans un channel
   * @param channelId - ID du channel (ex: 'general', 'meshcore-fr')
   * @param content - Contenu du message
   */
  publishChannelMessage: (channelId: string, content: string) => Promise<void>;
  
  /**
   * S'abonner aux DMs entrants
   * @param handler - Callback appelé pour chaque DM reçu
   * @returns Fonction de désabonnement
   */
  subscribeDMs: (handler: (from: string, content: string) => void) => () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useNostrHermes(): UseNostrHermesReturn {
  // ─── État local ─────────────────────────────────────────────────────────────
  
  const [isConnected, setIsConnected] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [relays, setRelays] = useState<string[]>([]);
  
  // Récupérer les infos du wallet
  const walletInfo = useWalletStore((s) => s.walletInfo);
  
  // Référence pour éviter les re-subscriptions et gérer le cleanup
  const subscriptionsRef = useRef<Array<() => void>>([]);
  const isMountedRef = useRef(true);
  
  // ─── Cleanup au démontage ───────────────────────────────────────────────────
  
  useEffect(() => {
    isMountedRef.current = true;
    
    return () => {
      isMountedRef.current = false;
      // Cleanup toutes les subscriptions au démontage
      subscriptionsRef.current.forEach(unsub => unsub());
      subscriptionsRef.current = [];
    };
  }, []);
  
  // ─── Synchronisation avec le wallet ─────────────────────────────────────────
  
  useEffect(() => {
    if (walletInfo?.nostrPubkey) {
      setPublicKey(walletInfo.nostrPubkey);
    } else {
      setPublicKey(null);
    }
  }, [walletInfo]);
  
  // ─── Souscription aux événements de connexion ─────────────────────────────────
  
  useEffect(() => {
    const unsubscribers: Array<() => void> = [];
    
    // Transport connecté
    const connectedUnsub = hermes.on(EventType.TRANSPORT_CONNECTED, ((event: HermesEvent) => {
      if (!isMountedRef.current) return;
      
      if (event.payload && typeof event.payload === 'object') {
        const payload = event.payload as { transport?: Transport; endpoint?: string };
        if (payload.transport === Transport.NOSTR) {
          setIsConnected(true);
          if (payload.endpoint) {
            // L'endpoint peut être une liste de relays séparés par des virgules
            const relayList = payload.endpoint.split(',').map(r => r.trim()).filter(Boolean);
            setRelays(relayList.length > 0 ? relayList : DEFAULT_RELAYS);
          } else {
            setRelays(DEFAULT_RELAYS);
          }
        }
      }
    }) as EventHandler);
    
    unsubscribers.push(connectedUnsub);
    
    // Transport déconnecté
    const disconnectedUnsub = hermes.on(EventType.TRANSPORT_DISCONNECTED, ((event: HermesEvent) => {
      if (!isMountedRef.current) return;
      
      if (event.payload && typeof event.payload === 'object') {
        const payload = event.payload as { transport?: Transport };
        if (payload.transport === Transport.NOSTR) {
          setIsConnected(false);
        }
      }
    }) as EventHandler);
    
    unsubscribers.push(disconnectedUnsub);
    
    // Erreur de transport
    const errorUnsub = hermes.on(EventType.TRANSPORT_ERROR, ((event: HermesEvent) => {
      if (!isMountedRef.current) return;
      
      if (event.payload && typeof event.payload === 'object') {
        const payload = event.payload as { transport?: Transport; error?: string };
        if (payload.transport === Transport.NOSTR) {
          setIsConnected(false);
          console.error('[useNostrHermes] Transport error:', payload.error);
        }
      }
    }) as EventHandler);
    
    unsubscribers.push(errorUnsub);
    
    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, []);
  
  // ─── Actions ─────────────────────────────────────────────────────────────────
  
  const connect = useCallback(async (customRelays?: string[]): Promise<void> => {
    const targetRelays = customRelays ?? DEFAULT_RELAYS;
    
    try {
      // Émettre événement de connexion
      await hermes.createEvent(
        EventType.TRANSPORT_CONNECTED,
        {
          transport: Transport.NOSTR,
          endpoint: targetRelays.join(', '),
        },
        { transport: Transport.NOSTR }
      );
      
      if (isMountedRef.current) {
        setIsConnected(true);
        setRelays(targetRelays);
      }
      
      // Récupérer la clé publique du wallet
      if (walletInfo?.nostrPubkey && isMountedRef.current) {
        setPublicKey(walletInfo.nostrPubkey);
      }
    } catch (error) {
      console.error('[useNostrHermes] Connection error:', error);
      throw error;
    }
  }, [walletInfo]);
  
  const disconnect = useCallback(async (): Promise<void> => {
    try {
      await hermes.createEvent(
        EventType.TRANSPORT_DISCONNECTED,
        { transport: Transport.NOSTR },
        { transport: Transport.NOSTR }
      );
      
      if (isMountedRef.current) {
        setIsConnected(false);
      }
    } catch (error) {
      console.error('[useNostrHermes] Disconnect error:', error);
      throw error;
    }
  }, []);
  
  const publishDM = useCallback(async (toPubkey: string, content: string): Promise<void> => {
    if (!isConnected) {
      throw new Error('Nostr not connected');
    }
    
    try {
      // Émettre via Hermès
      await hermes.createEvent(
        EventType.DM_SENT,
        {
          content,
          contentType: 'text',
          encryption: 'nip44',
          to: toPubkey,
        },
        {
          transport: Transport.NOSTR,
          from: publicKey ?? 'unknown',
          to: toPubkey,
        }
      );
    } catch (error) {
      console.error('[useNostrHermes] Publish DM error:', error);
      throw error;
    }
  }, [isConnected, publicKey]);
  
  const publishChannelMessage = useCallback(async (channelId: string, content: string): Promise<void> => {
    if (!isConnected) {
      throw new Error('Nostr not connected');
    }
    
    try {
      await hermes.createEvent(
        EventType.CHANNEL_MSG_SENT,
        {
          content,
          contentType: 'text',
          channelName: channelId,
        },
        {
          transport: Transport.NOSTR,
          from: publicKey ?? 'unknown',
          to: channelId,
        }
      );
    } catch (error) {
      console.error('[useNostrHermes] Publish channel message error:', error);
      throw error;
    }
  }, [isConnected, publicKey]);
  
  const subscribeDMs = useCallback((handler: (from: string, content: string) => void): (() => void) => {
    // S'abonner aux événements DM_RECEIVED via Hermès
    const unsubscribe = hermes.on(EventType.DM_RECEIVED, (event: HermesEvent) => {
      if (event.payload && typeof event.payload === 'object') {
        const payload = event.payload as { from?: string; content?: string; fromPubkey?: string };
        const from = payload.from ?? payload.fromPubkey ?? 'unknown';
        const content = payload.content ?? '';
        handler(from, content);
      }
    });
    
    subscriptionsRef.current.push(unsubscribe);
    
    return () => {
      unsubscribe();
      subscriptionsRef.current = subscriptionsRef.current.filter(s => s !== unsubscribe);
    };
  }, []);
  
  // ─── Return ───────────────────────────────────────────────────────────────────
  
  return {
    isConnected,
    publicKey,
    relays,
    connect,
    disconnect,
    publishDM,
    publishChannelMessage,
    subscribeDMs,
  };
}

export default useNostrHermes;
