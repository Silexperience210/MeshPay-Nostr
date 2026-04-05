/**
 * useConnection - Hook de gestion de l'état des transports
 * 
 * Remplace: useBle(), useNostr() - État de connexion
 * 
 * Fournit:
 * - État de connexion Nostr
 * - État de connexion LoRa/BLE
 * - Actions pour connecter/déconnecter
 * - Événements de changement d'état
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { hermes } from '../HermesEngine';
import { 
  EventType, 
  Transport, 
  ConnectionEvent,
  EventHandler,
} from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface TransportState {
  status: ConnectionStatus;
  error?: string;
  endpoint?: string;
  reconnectAttempt?: number;
}

export interface UseConnectionReturn {
  // ─── Nostr ──────────────────────────────────────────────────────────────────
  nostrStatus: ConnectionStatus;
  nostrConnected: boolean;
  nostrError?: string;
  nostrEndpoint?: string;
  connectNostr: () => Promise<void>;
  disconnectNostr: () => Promise<void>;
  reconnectNostr: () => Promise<void>;
  
  // ─── LoRa ───────────────────────────────────────────────────────────────────
  loRaStatus: ConnectionStatus;
  loRaConnected: boolean;
  loRaError?: string;
  loRaEndpoint?: string;
  connectLoRa: (deviceId: string) => Promise<void>;
  disconnectLoRa: () => Promise<void>;
  
  // ─── USB ────────────────────────────────────────────────────────────────────
  usbStatus: ConnectionStatus;
  usbConnected: boolean;
  connectUsb: (port: string) => Promise<void>;
  disconnectUsb: () => Promise<void>;
  
  // ─── Général ────────────────────────────────────────────────────────────────
  /** Nombre de transports connectés */
  connectedCount: number;
  /** Au moins un transport est connecté */
  isOnline: boolean;
  /** Démarrer tous les adapters configurés */
  startAll: () => Promise<void>;
  /** Arrêter tous les adapters */
  stopAll: () => Promise<void>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useConnection(): UseConnectionReturn {
  // ─── State ──────────────────────────────────────────────────────────────────
  const [nostrState, setNostrState] = useState<TransportState>({ 
    status: 'disconnected' 
  });
  const [loRaState, setLoRaState] = useState<TransportState>({ 
    status: 'disconnected' 
  });
  const [usbState, setUsbState] = useState<TransportState>({ 
    status: 'disconnected' 
  });
  
  const isMounted = useRef(true);
  
  // ─── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);
  
  // ─── Souscription aux événements de connexion ───────────────────────────────
  useEffect(() => {
    const unsubscribers: Array<() => void> = [];
    
    // Transport connecté
    const connectedUnsub = hermes.on(EventType.TRANSPORT_CONNECTED, ((event: ConnectionEvent) => {
      if (!isMounted.current) return;
      
      const update: TransportState = {
        status: 'connected',
        endpoint: event.payload.endpoint,
      };
      
      switch (event.payload.transport) {
        case Transport.NOSTR:
          setNostrState(update);
          break;
        case Transport.LORA:
          setLoRaState(update);
          break;
        case Transport.USB:
          setUsbState(update);
          break;
      }
    }) as EventHandler);
    
    unsubscribers.push(connectedUnsub);
    
    // Transport déconnecté
    const disconnectedUnsub = hermes.on(EventType.TRANSPORT_DISCONNECTED, ((event: ConnectionEvent) => {
      if (!isMounted.current) return;
      
      const update: TransportState = {
        status: 'disconnected',
        endpoint: event.payload.endpoint,
      };
      
      switch (event.payload.transport) {
        case Transport.NOSTR:
          setNostrState(update);
          break;
        case Transport.LORA:
          setLoRaState(update);
          break;
        case Transport.USB:
          setUsbState(update);
          break;
      }
    }) as EventHandler);
    
    unsubscribers.push(disconnectedUnsub);
    
    // Erreur de transport
    const errorUnsub = hermes.on(EventType.TRANSPORT_ERROR, ((event: ConnectionEvent) => {
      if (!isMounted.current) return;
      
      const update: TransportState = {
        status: 'error',
        error: event.payload.error,
        endpoint: event.payload.endpoint,
        reconnectAttempt: event.payload.reconnectAttempt,
      };
      
      switch (event.payload.transport) {
        case Transport.NOSTR:
          setNostrState(update);
          break;
        case Transport.LORA:
          setLoRaState(update);
          break;
        case Transport.USB:
          setUsbState(update);
          break;
      }
    }) as EventHandler);
    
    unsubscribers.push(errorUnsub);
    
    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, []);
  
  // ─── Actions Nostr ──────────────────────────────────────────────────────────
  
  const connectNostr = useCallback(async (): Promise<void> => {
    setNostrState(prev => ({ ...prev, status: 'connecting' }));
    
    try {
      const adapter = hermes.getAdapter(Transport.NOSTR);
      if (!adapter) {
        throw new Error('Adapter Nostr non enregistré');
      }
      
      if (adapter.isConnected) {
        setNostrState({ status: 'connected' });
        return;
      }
      
      await adapter.start();
    } catch (err) {
      if (isMounted.current) {
        setNostrState({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }, []);
  
  const disconnectNostr = useCallback(async (): Promise<void> => {
    try {
      const adapter = hermes.getAdapter(Transport.NOSTR);
      if (adapter) {
        await adapter.stop();
      }
    } catch (err) {
      console.error('[useConnection] Erreur déconnexion Nostr:', err);
    }
  }, []);
  
  const reconnectNostr = useCallback(async (): Promise<void> => {
    await disconnectNostr();
    await connectNostr();
  }, [disconnectNostr, connectNostr]);
  
  // ─── Actions LoRa ───────────────────────────────────────────────────────────
  
  const connectLoRa = useCallback(async (deviceId: string): Promise<void> => {
    setLoRaState(prev => ({ ...prev, status: 'connecting' }));
    
    try {
      const adapter = hermes.getAdapter(Transport.LORA);
      if (!adapter) {
        throw new Error('Adapter LoRa non enregistré');
      }
      
      // L'adapter LoRa a une méthode connect spécifique
      const loRaAdapter = adapter as any;
      if (typeof loRaAdapter.connect === 'function') {
        await loRaAdapter.connect(deviceId);
      } else {
        throw new Error('Méthode connect non disponible sur LoRaAdapter');
      }
    } catch (err) {
      if (isMounted.current) {
        setLoRaState({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }, []);
  
  const disconnectLoRa = useCallback(async (): Promise<void> => {
    try {
      const adapter = hermes.getAdapter(Transport.LORA);
      if (adapter) {
        const loRaAdapter = adapter as any;
        if (typeof loRaAdapter.disconnect === 'function') {
          await loRaAdapter.disconnect();
        } else {
          await adapter.stop();
        }
      }
    } catch (err) {
      console.error('[useConnection] Erreur déconnexion LoRa:', err);
    }
  }, []);
  
  // ─── Actions USB ────────────────────────────────────────────────────────────
  
  const connectUsb = useCallback(async (port: string): Promise<void> => {
    setUsbState(prev => ({ ...prev, status: 'connecting' }));
    
    try {
      const adapter = hermes.getAdapter(Transport.USB);
      if (!adapter) {
        throw new Error('Adapter USB non enregistré');
      }
      
      await adapter.start();
    } catch (err) {
      if (isMounted.current) {
        setUsbState({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }, []);
  
  const disconnectUsb = useCallback(async (): Promise<void> => {
    try {
      const adapter = hermes.getAdapter(Transport.USB);
      if (adapter) {
        await adapter.stop();
      }
    } catch (err) {
      console.error('[useConnection] Erreur déconnexion USB:', err);
    }
  }, []);
  
  // ─── Actions générales ──────────────────────────────────────────────────────
  
  const startAll = useCallback(async (): Promise<void> => {
    await Promise.all([
      connectNostr().catch(() => {}),
      // LoRa nécessite un deviceId, donc pas de connexion auto ici
    ]);
  }, [connectNostr]);
  
  const stopAll = useCallback(async (): Promise<void> => {
    await Promise.all([
      disconnectNostr(),
      disconnectLoRa(),
      disconnectUsb(),
    ]);
  }, [disconnectNostr, disconnectLoRa, disconnectUsb]);
  
  // ─── Computed ───────────────────────────────────────────────────────────────
  
  const connectedCount = [
    nostrState.status === 'connected',
    loRaState.status === 'connected',
    usbState.status === 'connected',
  ].filter(Boolean).length;
  
  const isOnline = connectedCount > 0;
  
  // ─── Return ─────────────────────────────────────────────────────────────────
  
  return {
    // Nostr
    nostrStatus: nostrState.status,
    nostrConnected: nostrState.status === 'connected',
    nostrError: nostrState.error,
    nostrEndpoint: nostrState.endpoint,
    connectNostr,
    disconnectNostr,
    reconnectNostr,
    
    // LoRa
    loRaStatus: loRaState.status,
    loRaConnected: loRaState.status === 'connected',
    loRaError: loRaState.error,
    loRaEndpoint: loRaState.endpoint,
    connectLoRa,
    disconnectLoRa,
    
    // USB
    usbStatus: usbState.status,
    usbConnected: usbState.status === 'connected',
    connectUsb,
    disconnectUsb,
    
    // Général
    connectedCount,
    isOnline,
    startAll,
    stopAll,
  };
}

export default useConnection;
