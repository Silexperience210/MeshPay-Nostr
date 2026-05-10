/**
 * useHermes - Hook principal d'accès au Hermès Engine
 * 
 * Fournit l'instance singleton et des helpers typés pour:
 * - Envoyer des DMs via Nostr
 * - Envoyer des messages via LoRa
 * - Souscrire aux événements de message
 * - Créer et émettre des événements personnalisés
 */

import { useCallback, useMemo } from 'react';
import { hermes, HermesEngine } from '../HermesEngine';
import { 
  EventType, 
  Transport, 
  HermesEvent, 
  MessageEvent, 
  EventHandler,
  EventFilter,
} from '../types';
import { EventBuilder } from '../utils/EventBuilder';

export interface UseHermesReturn {
  /** Instance singleton du Hermès Engine */
  hermes: HermesEngine;
  
  // ─── Helpers d'envoi ────────────────────────────────────────────────────────
  
  /** Envoyer un DM via Nostr */
  sendDM: (to: string, content: string, options?: { contentType?: string }) => Promise<void>;
  
  /** Envoyer un message via LoRa (broadcast) */
  sendLoRa: (content: string, options?: { contentType?: string }) => Promise<void>;
  
  /** Envoyer un message en utilisant le meilleur transport disponible */
  sendMessage: (to: string, content: string, options?: { 
    contentType?: string;
    preferredTransport?: Transport;
  }) => Promise<void>;
  
  // ─── Souscription ───────────────────────────────────────────────────────────
  
  /** Souscrire aux DMs entrants */
  onDMReceived: (handler: (event: MessageEvent) => void) => () => void;
  
  /** Souscrire aux messages de channel entrants */
  onChannelMessage: (handler: (event: MessageEvent) => void) => () => void;
  
  /** Souscrire à un type d'événement spécifique */
  on: <T extends HermesEvent>(type: EventType, handler: EventHandler<T>) => () => void;
  
  /** Souscrire avec un filtre avancé */
  subscribe: (filter: EventFilter, handler: EventHandler) => () => void;
  
  // ─── Utilitaires ────────────────────────────────────────────────────────────
  
  /** Créer un EventBuilder pour construire des événements complexes */
  builder: typeof EventBuilder;
  
  /** Émettre un événement personnalisé */
  emit: (event: HermesEvent, targetTransport?: Transport) => Promise<void>;
  
  /** Vérifier si un transport est disponible et connecté */
  isTransportConnected: (transport: Transport) => boolean;
  
  /** Obtenir les statistiques du engine */
  stats: () => { adapters: number; subscriptions: number; dedupSize: number; isRunning: boolean };
}

export function useHermes(): UseHermesReturn {
  // ─── Helpers d'envoi ────────────────────────────────────────────────────────
  
  const sendDM = useCallback(async (
    to: string, 
    content: string, 
    options?: { contentType?: string }
  ): Promise<void> => {
    const event = EventBuilder.dm()
      .to(to)
      .content(content, options?.contentType || 'text')
      .build();
    
    await hermes.emit(event, Transport.NOSTR);
  }, []);
  
  const sendLoRa = useCallback(async (
    content: string, 
    options?: { contentType?: string }
  ): Promise<void> => {
    const event = EventBuilder.channel()
      .content(content, options?.contentType || 'text')
      .build();
    
    await hermes.emit(event, Transport.LORA);
  }, []);
  
  const sendMessage = useCallback(async (
    to: string, 
    content: string, 
    options?: { contentType?: string; preferredTransport?: Transport }
  ): Promise<void> => {
    const preferredTransport = options?.preferredTransport;
    
    // Si un transport préféré est spécifié et disponible, l'utiliser
    if (preferredTransport) {
      const adapter = hermes.getAdapter(preferredTransport);
      if (adapter?.isConnected) {
        const event = EventBuilder.dm()
          .to(to)
          .content(content, options?.contentType || 'text')
          .build();
        await hermes.emit(event, preferredTransport);
        return;
      }
    }
    
    // Essayer Nostr d'abord
    const nostrAdapter = hermes.getAdapter(Transport.NOSTR);
    if (nostrAdapter?.isConnected) {
      await sendDM(to, content, options);
      return;
    }
    
    // Fallback LoRa si disponible
    const loRaAdapter = hermes.getAdapter(Transport.LORA);
    if (loRaAdapter?.isConnected) {
      const event = EventBuilder.dm()
        .to(to)
        .content(content, options?.contentType || 'text')
        .build();
      await hermes.emit(event, Transport.LORA);
      return;
    }
    
    throw new Error('Aucun transport disponible');
  }, [sendDM]);
  
  // ─── Souscription ───────────────────────────────────────────────────────────
  
  const onDMReceived = useCallback((handler: (event: MessageEvent) => void): (() => void) => {
    return hermes.on(EventType.DM_RECEIVED, handler as EventHandler);
  }, []);
  
  const onChannelMessage = useCallback((handler: (event: MessageEvent) => void): (() => void) => {
    return hermes.on(EventType.CHANNEL_MSG_RECEIVED, handler as EventHandler);
  }, []);
  
  const on = useCallback(<T extends HermesEvent>(
    type: EventType, 
    handler: EventHandler<T>
  ): (() => void) => {
    return hermes.on(type, handler as EventHandler);
  }, []);
  
  const subscribe = useCallback((
    filter: EventFilter, 
    handler: EventHandler
  ): (() => void) => {
    return hermes.subscribe(filter, handler);
  }, []);
  
  // ─── Utilitaires ────────────────────────────────────────────────────────────
  
  const emit = useCallback(async (
    event: HermesEvent, 
    targetTransport?: Transport
  ): Promise<void> => {
    await hermes.emit(event, targetTransport);
  }, []);
  
  const isTransportConnected = useCallback((transport: Transport): boolean => {
    const adapter = hermes.getAdapter(transport);
    return adapter?.isConnected ?? false;
  }, []);
  
  const stats = useCallback(() => hermes.stats, []);
  
  // ─── Memoization ────────────────────────────────────────────────────────────
  
  const returnValue = useMemo((): UseHermesReturn => ({
    hermes,
    sendDM,
    sendLoRa,
    sendMessage,
    onDMReceived,
    onChannelMessage,
    on,
    subscribe,
    builder: EventBuilder,
    emit,
    isTransportConnected,
    stats,
  }), [
    sendDM, 
    sendLoRa, 
    sendMessage, 
    onDMReceived, 
    onChannelMessage, 
    on, 
    subscribe, 
    emit, 
    isTransportConnected, 
    stats,
  ]);
  
  return returnValue;
}

export default useHermes;
