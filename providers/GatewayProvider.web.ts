import { useState, useCallback } from 'react';
import createContextHook from '@nkzw/create-context-hook';

export type GatewayMode = 'client' | 'gateway';
export type GatewayServiceType = 'mempool' | 'cashu' | 'lora';

export interface GatewayPeer {
  nodeId: string;
  name: string;
  lastSeen: number;
  signalStrength: number;
  hops: number;
  capabilities: string[];
  isGateway: boolean;
}

export interface GatewayState {
  mode: GatewayMode;
  isActive: boolean;
  services: Record<GatewayServiceType, boolean>;
  peers: GatewayPeer[];
  relayJobs: never[];
  stats: {
    txRelayed: number;
    cashuRelayed: number;
    messagesRelayed: number;
    chunksReassembled: number;
    paymentsForwarded: number;
    errors: number;
  };
  mempoolUrl: string;
  cashuMintUrl: string;
  activatedAt: number | null;
}

export interface GatewaySettings {
  mode: GatewayMode;
  autoActivate: boolean;
  services: Record<GatewayServiceType, boolean>;
  mempoolUrl: string;
  cashuMintUrl: string;
  cleanupIntervalMs: number;
  maxRelayJobAge: number;
  maxPeerAge: number;
}

const DEFAULT_GATEWAY_SETTINGS: GatewaySettings = {
  mode: 'client',
  autoActivate: false,
  services: { mempool: true, cashu: true, lora: true },
  mempoolUrl: 'https://mempool.space',
  cashuMintUrl: 'https://mint.minibits.cash/Bitcoin',
  cleanupIntervalMs: 60000,
  maxRelayJobAge: 3600000,
  maxPeerAge: 300000,
};

export const [GatewayContext, useGateway] = createContextHook(() => {
  const [gatewayState] = useState<GatewayState>({
    mode: 'client',
    isActive: false,
    services: { mempool: true, cashu: true, lora: true },
    peers: [],
    relayJobs: [],
    stats: {
      txRelayed: 0,
      cashuRelayed: 0,
      messagesRelayed: 0,
      chunksReassembled: 0,
      paymentsForwarded: 0,
      errors: 0,
    },
    mempoolUrl: 'https://mempool.space',
    cashuMintUrl: 'https://mint.minibits.cash/Bitcoin',
    activatedAt: null,
  });

  const [settings, setSettings] = useState<GatewaySettings>(DEFAULT_GATEWAY_SETTINGS);

  const updateSettings = useCallback((partial: Partial<GatewaySettings>) => {
    console.log('[Gateway-Web] updateSettings:', partial);
    setSettings(prev => ({ ...prev, ...partial }));
  }, []);

  const toggleService = useCallback((service: GatewayServiceType, val: boolean) => {
    console.log('[Gateway-Web] toggleService:', service, val);
    setSettings(prev => ({
      ...prev,
      services: { ...prev.services, [service]: val },
    }));
  }, []);

  return {
    gatewayState,
    settings,
    updateSettings,
    activateGateway: () => console.log('[Gateway-Web] Not available on web'),
    deactivateGateway: () => console.log('[Gateway-Web] Not available on web'),
    broadcastTx: () => {},
    relayCashu: () => {},
    handleLoRaMessage: () => {},
    forwardPayment: async () => { console.log('[Gateway-Web] Not available on web'); },
    registerPeer: () => {},
    toggleService,
    getUptime: () => '0s',
    isActivating: false,
    isDeactivating: false,
    isBroadcasting: false,
    isRelaying: false,
    isLoading: false,
  };
});
