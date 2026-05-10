import React, { createContext, useContext } from 'react';

export interface MeshCoreDevice {
  id: number;
  name: string;
  vendorId: number;
  productId: number;
}

export interface MeshCoreContact {
  publicKey: string;
  advName: string;
  lastSeen: number;
}

export interface MeshCoreMessage {
  senderPublicKey: string;
  text: string;
  timestamp: number;
}

export interface MeshCoreChannel {
  index: number;
  name: string;
}

interface MeshCoreContextValue {
  connected: boolean;
  device: null;
  scanning: boolean;
  availableDevices: never[];
  contacts: never[];
  error: string | null;
  isCompanion: boolean;
  deviceType: null;
  batteryVoltage: null;
  deviceInfo: null;
  scanForDevices: () => Promise<void>;
  connectToDevice: (deviceId: number, type?: string) => Promise<void>;
  disconnectDevice: () => Promise<void>;
  sendMessage: (publicKey: string, text: string) => Promise<void>;
  sendChannelMessage: (channelIdx: number, text: string) => Promise<void>;
  getContacts: () => Promise<MeshCoreContact[]>;
  getStatus: (contactPublicKey: string) => Promise<any>;
  sendRawData: (data: Uint8Array) => Promise<void>;
  syncNextMessage: () => Promise<any>;
  getChannel: (channelIdx: number) => Promise<MeshCoreChannel | null>;
  setChannel: (channelIdx: number, name: string, secret: string) => Promise<void>;
  getBatteryVoltage: () => Promise<number | null>;
  queryDevice: () => Promise<any>;
  setAdvertName: (name: string) => Promise<void>;
  setAdvertLatLon: (lat: number, lon: number) => Promise<void>;
  setTxPower: (power: number) => Promise<void>;
  setRadioParams: (freq: number, bw: number, sf: number, cr: number) => Promise<void>;
  reboot: () => Promise<void>;
  sendSelfAdvert: () => Promise<void>;
  exportContact: (pubKey?: string) => Promise<any>;
  removeContact: (pubKey: string) => Promise<void>;
  shareContact: (pubKey: string) => Promise<void>;
  login: (publicKey: string, password: string) => Promise<void>;
  requestTelemetry: (publicKey: string) => Promise<any>;
}

const MeshCoreContext = createContext<MeshCoreContextValue | null>(null);

export function useMeshCore(): MeshCoreContextValue {
  const context = useContext(MeshCoreContext);
  if (!context) {
    throw new Error('useMeshCore must be used within MeshCoreProvider');
  }
  return context;
}

const noopAsync = async () => {
  console.log('[MeshCore-Web] MeshCore not available on web');
};

export function MeshCoreProvider({ children }: { children: React.ReactNode }) {
  const value: MeshCoreContextValue = {
    connected: false,
    device: null,
    scanning: false,
    availableDevices: [],
    contacts: [],
    error: 'MeshCore not available on web',
    isCompanion: false,
    deviceType: null,
    batteryVoltage: null,
    deviceInfo: null,
    scanForDevices: noopAsync,
    connectToDevice: noopAsync,
    disconnectDevice: noopAsync,
    sendMessage: noopAsync,
    sendChannelMessage: noopAsync,
    getContacts: async () => [],
    getStatus: async () => null,
    sendRawData: noopAsync,
    syncNextMessage: async () => null,
    getChannel: async () => null,
    setChannel: noopAsync,
    getBatteryVoltage: async () => null,
    queryDevice: async () => null,
    setAdvertName: noopAsync,
    setAdvertLatLon: noopAsync,
    setTxPower: noopAsync,
    setRadioParams: noopAsync,
    reboot: noopAsync,
    sendSelfAdvert: noopAsync,
    exportContact: async () => null,
    removeContact: noopAsync,
    shareContact: noopAsync,
    login: noopAsync,
    requestTelemetry: async () => null,
  };

  return (
    <MeshCoreContext.Provider value={value}>{children}</MeshCoreContext.Provider>
  );
}
