/**
 * useGateway - Hook React pour le GatewayManager
 *
 * Phase 3.2: Remplace le GatewayProvider legacy
 */

import { useState, useEffect, useCallback } from 'react';
import { gatewayManager, type GatewayStatus } from '../gateway/GatewayManager';
import { hermes } from '../HermesEngine';
import { EventType } from '../types';

export interface UseGatewayReturn {
  /** Statut du gateway */
  status: GatewayStatus;

  /** Forcer un bridge manuel */
  bridgeMessage: (payload: string, from: 'lora' | 'nostr', to: 'lora' | 'nostr') => Promise<void>;

  /** Activer/desactiver un bridge */
  setBridgeEnabled: (direction: 'loraToNostr' | 'nostrToLora', enabled: boolean) => void;

  /** Demarrer le gateway */
  start: () => Promise<void>;

  /** Arreter le gateway */
  stop: () => Promise<void>;

  /** Reset les statistiques */
  resetStats: () => void;
}

export function useGateway(): UseGatewayReturn {
  const [status, setStatus] = useState<GatewayStatus>(gatewayManager.getStatus());

  // Demarrer automatiquement au montage + souscription aux evenements
  useEffect(() => {
    gatewayManager.start();

    // Souscription aux evenements de bridge pour mise a jour en temps reel
    const unsubBridge = hermes.on(EventType.BRIDGE_LORA_TO_NOSTR, () => {
      setStatus(gatewayManager.getStatus());
    });
    const unsubBridge2 = hermes.on(EventType.BRIDGE_NOSTR_TO_LORA, () => {
      setStatus(gatewayManager.getStatus());
    });

    return () => {
      unsubBridge();
      unsubBridge2();
      gatewayManager.stop();
    };
  }, []);

  const bridgeMessage = useCallback(async (
    payload: string,
    from: 'lora' | 'nostr',
    to: 'lora' | 'nostr'
  ) => {
    await gatewayManager.bridgeMessage(payload, from as any, to as any);

    // Mettre a jour le statut immediatement
    setStatus(gatewayManager.getStatus());
  }, []);

  const setBridgeEnabled = useCallback((
    direction: 'loraToNostr' | 'nostrToLora',
    enabled: boolean
  ) => {
    gatewayManager.setBridgeEnabled(direction, enabled);
    setStatus(gatewayManager.getStatus());
  }, []);

  const start = useCallback(async () => {
    await gatewayManager.start();
    setStatus(gatewayManager.getStatus());
  }, []);

  const stop = useCallback(async () => {
    await gatewayManager.stop();
    setStatus(gatewayManager.getStatus());
  }, []);

  const resetStats = useCallback(() => {
    gatewayManager.resetStats();
    setStatus(gatewayManager.getStatus());
  }, []);

  return {
    status,
    bridgeMessage,
    setBridgeEnabled,
    start,
    stop,
    resetStats,
  };
}
