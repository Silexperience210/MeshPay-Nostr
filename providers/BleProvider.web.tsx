import React, { createContext, useContext } from 'react';

interface BleContextValue {
  connected: boolean;
  loraActive: boolean;
  device: null;
  deviceInfo: null;
  scanning: boolean;
  availableDevices: never[];
  error: string | null;
  scanForGateways: () => Promise<void>;
  connectToGateway: (deviceId: string) => Promise<void>;
  disconnectGateway: () => Promise<void>;
  sendPacket: (packet: any, timeoutMs?: number) => Promise<void>;
  onPacket: (handler: (packet: any) => void) => void;
  confirmLoraActive: () => void;
}

const BleContext = createContext<BleContextValue | null>(null);

export function useBle(): BleContextValue {
  const context = useContext(BleContext);
  if (!context) {
    throw new Error('useBle must be used within BleProvider');
  }
  return context;
}

const noopAsync = async () => {
  console.log('[BLE-Web] BLE not available on web');
};

export function BleProvider({ children }: { children: React.ReactNode }) {
  const value: BleContextValue = {
    connected: false,
    loraActive: false,
    device: null,
    deviceInfo: null,
    scanning: false,
    availableDevices: [],
    error: 'BLE not available on web',
    scanForGateways: noopAsync,
    connectToGateway: noopAsync,
    disconnectGateway: noopAsync,
    sendPacket: noopAsync,
    onPacket: () => {},
    confirmLoraActive: () => {},
  };

  return <BleContext.Provider value={value}>{children}</BleContext.Provider>;
}
