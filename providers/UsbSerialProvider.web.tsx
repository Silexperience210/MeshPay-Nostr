import React, { createContext, useContext } from 'react';

export interface UsbDevice {
  id: number;
  name: string;
  vendorId: number;
  productId: number;
}

interface UsbSerialContextValue {
  connected: boolean;
  device: null;
  scanning: boolean;
  availableDevices: never[];
  error: string | null;
  hasPermission: boolean;
  scanForDevices: () => Promise<void>;
  connectToDevice: (deviceId: number) => Promise<void>;
  disconnectDevice: () => Promise<void>;
  sendPacket: (packet: any) => Promise<void>;
  onPacket: (handler: (packet: any) => void) => void;
  requestPermission: () => Promise<boolean>;
}

const UsbSerialContext = createContext<UsbSerialContextValue | null>(null);

export function useUsbSerial(): UsbSerialContextValue {
  const context = useContext(UsbSerialContext);
  if (!context) {
    throw new Error('useUsbSerial must be used within UsbSerialProvider');
  }
  return context;
}

const noopAsync = async () => {
  console.log('[USB-Web] USB Serial not available on web');
};

export function UsbSerialProvider({ children }: { children: React.ReactNode }) {
  const value: UsbSerialContextValue = {
    connected: false,
    device: null,
    scanning: false,
    availableDevices: [],
    error: 'USB Serial not available on web',
    hasPermission: false,
    scanForDevices: noopAsync,
    connectToDevice: noopAsync,
    disconnectDevice: noopAsync,
    sendPacket: noopAsync,
    onPacket: () => {},
    requestPermission: async () => false,
  };

  return (
    <UsbSerialContext.Provider value={value}>{children}</UsbSerialContext.Provider>
  );
}
