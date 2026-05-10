/**
 * useBridge - Hook de contrôle du bridge LoRa ↔ Nostr
 * 
 * Remplace: useGateway() - Bridge, relay
 * 
 * Gère:
 * - Activation/désactivation du bridge
 * - Configuration du bridging automatique
 * - Statistiques de bridge
 * - Bridge manuel d'un message
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { hermes } from '../HermesEngine';
import { 
  EventType, 
  Transport, 
  BridgeEvent, 
  MessageEvent,
  EventHandler,
  HermesEvent,
} from '../types';
import { EventBuilder } from '../utils/EventBuilder';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BridgeStats {
  /** Messages relayés LoRa → Nostr */
  loraToNostr: number;
  /** Messages relayés Nostr → LoRa */
  nostrToLora: number;
  /** Dernier message relayé */
  lastRelayedAt: number | null;
  /** Erreurs de bridge */
  errors: number;
}

export interface UseBridgeReturn {
  // ─── Configuration ──────────────────────────────────────────────────────────
  /** Bridge automatique activé */
  autoBridge: boolean;
  /** Activer/désactiver le bridge automatique */
  setAutoBridge: (enabled: boolean) => void;
  /** Bridge actif (même si auto désactivé) */
  isBridgeEnabled: boolean;
  
  // ─── Actions ────────────────────────────────────────────────────────────────
  /** Activer le bridge */
  enableBridge: () => void;
  /** Désactiver le bridge */
  disableBridge: () => void;
  /** Basculer l'état du bridge */
  toggleBridge: () => void;
  
  /** 
   * Bridge manuel d'un message
   * @param event L'événement à relayer
   * @param targetTransport Transport cible
   */
  bridgeMessage: (
    event: HermesEvent, 
    targetTransport: Transport
  ) => Promise<void>;
  
  /** 
   * Créer un événement de bridge et l'émettre
   * @param content Contenu à relayer
   * @param fromTransport Transport source
   * @param toTransport Transport cible
   */
  createBridge: (
    content: string,
    fromTransport: Transport,
    toTransport: Transport,
    options?: { contentType?: string; originalId?: string }
  ) => Promise<void>;
  
  // ─── Statistiques ───────────────────────────────────────────────────────────
  stats: BridgeStats;
  /** Réinitialiser les statistiques */
  resetStats: () => void;
  
  // ─── Événements ─────────────────────────────────────────────────────────────
  /** Dernier événement de bridge reçu */
  lastBridgeEvent: BridgeEvent | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useBridge(): UseBridgeReturn {
  // ─── State ──────────────────────────────────────────────────────────────────
  const [autoBridge, setAutoBridgeState] = useState(true);
  const [isBridgeEnabled, setIsBridgeEnabled] = useState(true);
  const [stats, setStats] = useState<BridgeStats>({
    loraToNostr: 0,
    nostrToLora: 0,
    lastRelayedAt: null,
    errors: 0,
  });
  const [lastBridgeEvent, setLastBridgeEvent] = useState<BridgeEvent | null>(null);
  
  const isMounted = useRef(true);
  
  // ─── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);
  
  // ─── Chargement de la config ────────────────────────────────────────────────
  useEffect(() => {
    // Charger la configuration depuis AsyncStorage ou le store
    // Pour l'instant, valeurs par défaut
  }, []);
  
  // ─── Souscription aux événements de bridge ──────────────────────────────────
  useEffect(() => {
    if (!isBridgeEnabled) return;
    
    const unsubscribers: Array<() => void> = [];
    
    // Bridge LoRa → Nostr
    const loraToNostrUnsub = hermes.on(EventType.BRIDGE_LORA_TO_NOSTR, ((event: BridgeEvent) => {
      if (!isMounted.current) return;
      
      setLastBridgeEvent(event);
      
      if (autoBridge) {
        // Relayer vers Nostr
        const loraAdapter = hermes.getAdapter(Transport.LORA);
        if (loraAdapter) {
          const loRaAdapterAny = loraAdapter as any;
          if (loRaAdapterAny.config) {
            loRaAdapterAny.config.autoBridgeToNostr = true;
          }
        }
        
        setStats(prev => ({
          ...prev,
          loraToNostr: prev.loraToNostr + 1,
          lastRelayedAt: Date.now(),
        }));
      }
    }) as EventHandler);
    
    unsubscribers.push(loraToNostrUnsub);
    
    // Bridge Nostr → LoRa
    const nostrToLoraUnsub = hermes.on(EventType.BRIDGE_NOSTR_TO_LORA, ((event: BridgeEvent) => {
      if (!isMounted.current) return;
      
      setLastBridgeEvent(event);
      
      if (autoBridge) {
        setStats(prev => ({
          ...prev,
          nostrToLora: prev.nostrToLora + 1,
          lastRelayedAt: Date.now(),
        }));
      }
    }) as EventHandler);
    
    unsubscribers.push(nostrToLoraUnsub);
    
    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [isBridgeEnabled, autoBridge]);
  
  // ─── Actions ────────────────────────────────────────────────────────────────
  
  const enableBridge = useCallback((): void => {
    setIsBridgeEnabled(true);
    
    // Mettre à jour la config de l'adapter LoRa
    const loRaAdapter = hermes.getAdapter(Transport.LORA);
    if (loRaAdapter) {
      const adapter = loRaAdapter as any;
      if (adapter.config) {
        adapter.config.autoBridgeToNostr = true;
      }
    }
  }, []);
  
  const disableBridge = useCallback((): void => {
    setIsBridgeEnabled(false);
    
    // Mettre à jour la config de l'adapter LoRa
    const loRaAdapter = hermes.getAdapter(Transport.LORA);
    if (loRaAdapter) {
      const adapter = loRaAdapter as any;
      if (adapter.config) {
        adapter.config.autoBridgeToNostr = false;
      }
    }
  }, []);
  
  const toggleBridge = useCallback((): void => {
    if (isBridgeEnabled) {
      disableBridge();
    } else {
      enableBridge();
    }
  }, [isBridgeEnabled, enableBridge, disableBridge]);
  
  const setAutoBridge = useCallback((enabled: boolean): void => {
    setAutoBridgeState(enabled);
    
    // Mettre à jour la config de l'adapter LoRa
    const loRaAdapter = hermes.getAdapter(Transport.LORA);
    if (loRaAdapter) {
      const adapter = loRaAdapter as any;
      if (adapter.config) {
        adapter.config.autoBridgeToNostr = enabled;
      }
    }
  }, []);
  
  const bridgeMessage = useCallback(async (
    event: HermesEvent,
    targetTransport: Transport
  ): Promise<void> => {
    if (!isBridgeEnabled) {
      throw new Error('Bridge désactivé');
    }
    
    try {
      // Créer l'événement de bridge
      const bridgeEvent = EventBuilder.bridge()
        .raw({
          originalEvent: event,
          targetTransport,
        })
        .build();
      
      // Adapter le type selon la direction
      const bridgeType = event.transport === Transport.LORA && targetTransport === Transport.NOSTR
        ? EventType.BRIDGE_LORA_TO_NOSTR
        : EventType.BRIDGE_NOSTR_TO_LORA;
      
      (bridgeEvent as any).type = bridgeType;
      
      await hermes.emit(bridgeEvent, targetTransport);
      
      // Mettre à jour les stats
      setStats(prev => ({
        ...prev,
        [event.transport === Transport.LORA ? 'loraToNostr' : 'nostrToLora']: 
          prev[event.transport === Transport.LORA ? 'loraToNostr' : 'nostrToLora'] + 1,
        lastRelayedAt: Date.now(),
      }));
    } catch (err) {
      setStats(prev => ({ ...prev, errors: prev.errors + 1 }));
      throw err;
    }
  }, [isBridgeEnabled]);
  
  const createBridge = useCallback(async (
    content: string,
    fromTransport: Transport,
    toTransport: Transport,
    options?: { contentType?: string; originalId?: string }
  ): Promise<void> => {
    if (!isBridgeEnabled) {
      throw new Error('Bridge désactivé');
    }
    
    const eventType = fromTransport === Transport.LORA && toTransport === Transport.NOSTR
      ? EventType.BRIDGE_LORA_TO_NOSTR
      : EventType.BRIDGE_NOSTR_TO_LORA;
    
    const event = EventBuilder.bridge()
      .type(eventType)
      .raw({
        content,
        contentType: options?.contentType || 'text',
        originalTransport: fromTransport,
        targetTransport: toTransport,
        rawPayload: content,
      })
      .build();
    
    if (options?.originalId) {
      event.meta.originalId = options.originalId;
    }
    
    await hermes.emit(event, toTransport);
  }, [isBridgeEnabled]);
  
  const resetStats = useCallback((): void => {
    setStats({
      loraToNostr: 0,
      nostrToLora: 0,
      lastRelayedAt: null,
      errors: 0,
    });
  }, []);
  
  // ─── Return ─────────────────────────────────────────────────────────────────
  
  return {
    // Configuration
    autoBridge,
    setAutoBridge,
    isBridgeEnabled,
    
    // Actions
    enableBridge,
    disableBridge,
    toggleBridge,
    bridgeMessage,
    createBridge,
    
    // Stats
    stats,
    resetStats,
    
    // Événements
    lastBridgeEvent,
  };
}

export default useBridge;
