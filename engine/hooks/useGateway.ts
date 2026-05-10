/**
 * useGateway - Hook React pour le GatewayManager
 * 
 * Phase 3.2: Remplace le GatewayProvider legacy
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { gatewayManager, type GatewayStatus } from '../gateway/GatewayManager';
import { Transport } from '../types';

export interface UseGatewayReturn {
  /** Statut du gateway */
  status: GatewayStatus;
  
  /** Forcer un bridge manuel */
  bridgeMessage: (payload: string, from: 'lora' | 'nostr', to: 'lora' | 'nostr') => Promise<void>;
  
  /** Activer/désactiver un bridge */
  setBridgeEnabled: (direction: 'loraToNostr' | 'nostrToLora', enabled: boolean) => void;
  
  /** Démarrer le gateway */
  start: () => Promise<void>;
  
  /** Arrêter le gateway */
  stop: () => Promise<void>;
  
  /** Reset les statistiques */
  resetStats: () => void;
}

export function useGateway(): UseGatewayReturn {
  const [status, setStatus] = useState<GatewayStatus>(gatewayManager.getStatus());
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Démarrer automatiquement au montage
  useEffect(() => {
    gatewayManager.start();
    
    // Polling pour les stats (5 secondes)
    intervalRef.current = setInterval(() => {
      setStatus(gatewayManager.getStatus());
    }, 5000);
    
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      gatewayManager.stop();
    };
  }, []);

  const bridgeMessage = useCallback(async (
    payload: string, 
    from: 'lora' | 'nostr', 
    to: 'lora' | 'nostr'
  ) => {
    const fromTransport = from === 'lora' ? Transport.LORA : Transport.NOSTR;
    const toTransport = to === 'lora' ? Transport.LORA : Transport.NOSTR;
    
    await gatewayManager.bridgeMessage(payload, fromTransport, toTransport);
    
    // Mettre à jour le statut immédiatement
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
