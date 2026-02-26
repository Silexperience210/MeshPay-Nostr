/**
 * MeshCore Provider avec meshcore.js
 * 
 * Connexion USB Serial aux devices MeshCore en utilisant la librairie officielle
 * Supporte Companion, Room Server et Repeater
 */

import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import { Platform } from 'react-native';
import { UsbSerialManager } from 'react-native-usb-serialport-for-android';
// @ts-ignore - meshcore.js n'a pas de types
import SerialConnection from '@liamcottle/meshcore.js/src/connection/serial_connection.js';

const BaseSerialConnection = SerialConnection as unknown as { new (): any };

class ReactNativeSerialConnection extends BaseSerialConnection {
  private adapter: {
    write: (data: Uint8Array) => Promise<void>;
    onData: (callback: (data: Uint8Array) => void) => void;
    close: () => Promise<void>;
  };

  constructor(adapter: {
    write: (data: Uint8Array) => Promise<void>;
    onData: (callback: (data: Uint8Array) => void) => void;
    close: () => Promise<void>;
  }) {
    super();
    this.adapter = adapter;
  }

  async connect() {
    this.adapter.onData((data: Uint8Array) => {
      void this.onDataReceived(data);
    });
    await this.onConnected();
  }

  async close() {
    await this.adapter.close();
    this.onDisconnected();
  }

  async write(bytes: Uint8Array) {
    await this.adapter.write(bytes);
  }
}

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

interface MeshCoreState {
  connected: boolean;
  device: MeshCoreDevice | null;
  scanning: boolean;
  availableDevices: MeshCoreDevice[];
  contacts: MeshCoreContact[];
  error: string | null;
  isCompanion: boolean;
  deviceType: 'companion' | 'roomserver' | 'repeater' | null;
  batteryVoltage: number | null;
  deviceInfo: any | null;
}

interface MeshCoreContextValue extends MeshCoreState {
  scanForDevices: () => Promise<void>;
  connectToDevice: (deviceId: number, type?: 'companion' | 'roomserver' | 'repeater') => Promise<void>;
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

export function MeshCoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MeshCoreState>({
    connected: false,
    device: null,
    scanning: false,
    availableDevices: [],
    contacts: [],
    error: null,
    isCompanion: false,
    deviceType: null,
    batteryVoltage: null,
    deviceInfo: null,
  });

  const connectionRef = useRef<any>(null);

  const scanForDevices = useCallback(async () => {
    if (Platform.OS !== 'android') {
      setState(prev => ({ ...prev, error: 'USB Serial only available on Android' }));
      return;
    }

    setState(prev => ({ ...prev, scanning: true }));

    try {
      const devices = await UsbSerialManager.list();
      const mappedDevices: MeshCoreDevice[] = devices.map((d: any) => ({
        id: d.deviceId,
        name: d.deviceName || `MeshCore ${d.deviceId}`,
        vendorId: d.vendorId,
        productId: d.productId,
      }));

      setState(prev => ({
        ...prev,
        availableDevices: mappedDevices,
        scanning: false,
      }));
      console.log('[MeshCore] Found devices:', mappedDevices.length);
    } catch (err) {
      console.error('[MeshCore] Scan error:', err);
      setState(prev => ({ ...prev, scanning: false, error: 'Failed to scan USB devices' }));
    }
  }, []);

  const connectToDevice = useCallback(async (
    deviceId: number,
    type: 'companion' | 'roomserver' | 'repeater' = 'companion'
  ) => {
    try {
      const { createMeshCoreAdapter } = await import('@/utils/meshcore-usb');
      const adapter = await createMeshCoreAdapter(deviceId);

      const meshConnection = new ReactNativeSerialConnection(adapter as any);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);

        meshConnection.on('connected', () => {
          clearTimeout(timeout);
          resolve();
        });

        meshConnection.on('error', (err: any) => {
          clearTimeout(timeout);
          reject(err);
        });

        meshConnection.connect();
      });

      connectionRef.current = meshConnection;

      const device = state.availableDevices.find(d => d.id === deviceId);

      setState(prev => ({
        ...prev,
        connected: true,
        device: device || null,
        deviceType: type,
        isCompanion: type === 'companion',
        error: null,
      }));

      console.log('[MeshCore] Connected to device:', deviceId, 'Type:', type);

      try {
        await meshConnection.sendCommandAppStart();
        console.log('[MeshCore] AppStart command sent');
      } catch (err) {
        console.warn('[MeshCore] AppStart failed (may be okay):', err);
      }

      if (type === 'companion') {
        try {
          const contacts = await meshConnection.getContacts();
          setState(prev => ({ ...prev, contacts }));
          console.log('[MeshCore] Loaded', contacts?.length || 0, 'contacts');
        } catch (err) {
          console.warn('[MeshCore] Failed to load contacts:', err);
        }
      }

      try {
        const deviceInfo = await meshConnection.sendCommandDeviceQuery(1);
        setState(prev => ({ ...prev, deviceInfo }));
        console.log('[MeshCore] Device info:', deviceInfo);
      } catch (err) {
        console.warn('[MeshCore] Device query failed:', err);
      }

    } catch (err) {
      console.error('[MeshCore] Connection error:', err);
      setState(prev => ({ ...prev, error: 'Failed to connect to MeshCore device' }));
    }
  }, [state.availableDevices]);

  const disconnectDevice = useCallback(async () => {
    try {
      if (connectionRef.current) {
        connectionRef.current.close();
        connectionRef.current = null;
      }

      setState(prev => ({
        ...prev,
        connected: false,
        device: null,
        deviceType: null,
        isCompanion: false,
        contacts: [],
        batteryVoltage: null,
        deviceInfo: null,
      }));

      console.log('[MeshCore] Disconnected');
    } catch (err) {
      console.error('[MeshCore] Disconnect error:', err);
    }
  }, []);

  const sendMessage = useCallback(async (publicKey: string, text: string) => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected to MeshCore device');
    }

    try {
      const txtType = 0;
      const attempt = 0;
      const senderTimestamp = Math.floor(Date.now() / 1000);
      const pubKeyPrefix = publicKey.slice(0, 12);

      await connectionRef.current.sendCommandSendTxtMsg(
        txtType,
        attempt,
        senderTimestamp,
        pubKeyPrefix,
        text
      );
      console.log('[MeshCore] Message sent to:', publicKey.slice(0, 16));
    } catch (err) {
      console.error('[MeshCore] Send error:', err);
      throw err;
    }
  }, [state.connected]);

  const sendChannelMessage = useCallback(async (channelIdx: number, text: string) => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected to MeshCore device');
    }

    try {
      const txtType = 0;
      const senderTimestamp = Math.floor(Date.now() / 1000);

      await connectionRef.current.sendCommandSendChannelTxtMsg(
        txtType,
        channelIdx,
        senderTimestamp,
        text
      );
      console.log('[MeshCore] Channel message sent to channel:', channelIdx);
    } catch (err) {
      console.error('[MeshCore] Channel send error:', err);
      throw err;
    }
  }, [state.connected]);

  const getContacts = useCallback(async (): Promise<MeshCoreContact[]> => {
    if (!connectionRef.current || !state.connected) {
      return [];
    }

    try {
      const contacts = await connectionRef.current.getContacts();
      setState(prev => ({ ...prev, contacts }));
      return contacts;
    } catch (err) {
      console.error('[MeshCore] Get contacts error:', err);
      return [];
    }
  }, [state.connected]);

  const getStatus = useCallback(async (contactPublicKey: string) => {
    if (!connectionRef.current || !state.connected) {
      return null;
    }

    try {
      const status = await connectionRef.current.getStatus(contactPublicKey);
      return status;
    } catch (err) {
      console.error('[MeshCore] Get status error:', err);
      return null;
    }
  }, [state.connected]);

  const sendRawData = useCallback(async (data: Uint8Array) => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected to MeshCore device');
    }

    try {
      const path: number[] = [];
      await connectionRef.current.sendCommandSendRawData(path, data);
      console.log('[MeshCore] Raw data sent:', data.length, 'bytes');
    } catch (err) {
      console.error('[MeshCore] Send raw error:', err);
      throw err;
    }
  }, [state.connected]);

  const syncNextMessage = useCallback(async () => {
    if (!connectionRef.current || !state.connected) {
      return null;
    }

    try {
      const message = await connectionRef.current.sendCommandSyncNextMessage();
      return message;
    } catch (err) {
      console.error('[MeshCore] Sync message error:', err);
      return null;
    }
  }, [state.connected]);

  const getChannel = useCallback(async (channelIdx: number): Promise<MeshCoreChannel | null> => {
    if (!connectionRef.current || !state.connected) {
      return null;
    }

    try {
      const channel = await connectionRef.current.sendCommandGetChannel(channelIdx);
      return channel ? { index: channelIdx, name: channel.name || '' } : null;
    } catch (err) {
      console.error('[MeshCore] Get channel error:', err);
      return null;
    }
  }, [state.connected]);

  const setChannel = useCallback(async (channelIdx: number, name: string, secret: string) => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected');
    }

    try {
      await connectionRef.current.sendCommandSetChannel(channelIdx, name, secret);
      console.log('[MeshCore] Channel set:', channelIdx, name);
    } catch (err) {
      console.error('[MeshCore] Set channel error:', err);
      throw err;
    }
  }, [state.connected]);

  const getBatteryVoltage = useCallback(async (): Promise<number | null> => {
    if (!connectionRef.current || !state.connected) {
      return null;
    }

    try {
      const result = await connectionRef.current.sendCommandGetBatteryVoltage();
      const voltage = typeof result === 'number' ? result : result?.voltage;
      setState(prev => ({ ...prev, batteryVoltage: voltage }));
      return voltage;
    } catch (err) {
      console.error('[MeshCore] Battery voltage error:', err);
      return null;
    }
  }, [state.connected]);

  const queryDevice = useCallback(async () => {
    if (!connectionRef.current || !state.connected) {
      return null;
    }

    try {
      const info = await connectionRef.current.sendCommandDeviceQuery(1);
      setState(prev => ({ ...prev, deviceInfo: info }));
      return info;
    } catch (err) {
      console.error('[MeshCore] Device query error:', err);
      return null;
    }
  }, [state.connected]);

  const setAdvertName = useCallback(async (name: string) => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected');
    }

    try {
      await connectionRef.current.sendCommandSetAdvertName(name);
      console.log('[MeshCore] Advert name set:', name);
    } catch (err) {
      console.error('[MeshCore] Set advert name error:', err);
      throw err;
    }
  }, [state.connected]);

  const setAdvertLatLon = useCallback(async (lat: number, lon: number) => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected');
    }

    try {
      await connectionRef.current.sendCommandSetAdvertLatLon(lat, lon);
      console.log('[MeshCore] Advert lat/lon set:', lat, lon);
    } catch (err) {
      console.error('[MeshCore] Set advert lat/lon error:', err);
      throw err;
    }
  }, [state.connected]);

  const setTxPower = useCallback(async (power: number) => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected');
    }

    try {
      await connectionRef.current.sendCommandSetTxPower(power);
      console.log('[MeshCore] TX power set:', power);
    } catch (err) {
      console.error('[MeshCore] Set TX power error:', err);
      throw err;
    }
  }, [state.connected]);

  const setRadioParams = useCallback(async (freq: number, bw: number, sf: number, cr: number) => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected');
    }

    try {
      await connectionRef.current.sendCommandSetRadioParams(freq, bw, sf, cr);
      console.log('[MeshCore] Radio params set:', freq, bw, sf, cr);
    } catch (err) {
      console.error('[MeshCore] Set radio params error:', err);
      throw err;
    }
  }, [state.connected]);

  const reboot = useCallback(async () => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected');
    }

    try {
      await connectionRef.current.sendCommandReboot();
      console.log('[MeshCore] Reboot command sent');
      await disconnectDevice();
    } catch (err) {
      console.error('[MeshCore] Reboot error:', err);
      throw err;
    }
  }, [state.connected, disconnectDevice]);

  const sendSelfAdvert = useCallback(async () => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected');
    }

    try {
      const type = 0;
      await connectionRef.current.sendCommandSendSelfAdvert(type);
      console.log('[MeshCore] Self advert sent');
    } catch (err) {
      console.error('[MeshCore] Self advert error:', err);
      throw err;
    }
  }, [state.connected]);

  const exportContact = useCallback(async (pubKey?: string) => {
    if (!connectionRef.current || !state.connected) {
      return null;
    }

    try {
      const result = await connectionRef.current.sendCommandExportContact(pubKey || null);
      return result;
    } catch (err) {
      console.error('[MeshCore] Export contact error:', err);
      return null;
    }
  }, [state.connected]);

  const removeContact = useCallback(async (pubKey: string) => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected');
    }

    try {
      await connectionRef.current.sendCommandRemoveContact(pubKey);
      console.log('[MeshCore] Contact removed:', pubKey.slice(0, 16));
      const contacts = await connectionRef.current.getContacts();
      setState(prev => ({ ...prev, contacts }));
    } catch (err) {
      console.error('[MeshCore] Remove contact error:', err);
      throw err;
    }
  }, [state.connected]);

  const shareContact = useCallback(async (pubKey: string) => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected');
    }

    try {
      await connectionRef.current.sendCommandShareContact(pubKey);
      console.log('[MeshCore] Contact shared:', pubKey.slice(0, 16));
    } catch (err) {
      console.error('[MeshCore] Share contact error:', err);
      throw err;
    }
  }, [state.connected]);

  const login = useCallback(async (publicKey: string, password: string) => {
    if (!connectionRef.current || !state.connected) {
      throw new Error('Not connected');
    }

    try {
      await connectionRef.current.sendCommandSendLogin(publicKey, password);
      console.log('[MeshCore] Login sent to:', publicKey.slice(0, 16));
    } catch (err) {
      console.error('[MeshCore] Login error:', err);
      throw err;
    }
  }, [state.connected]);

  const requestTelemetry = useCallback(async (publicKey: string) => {
    if (!connectionRef.current || !state.connected) {
      return null;
    }

    try {
      const result = await connectionRef.current.sendCommandSendTelemetryReq(publicKey);
      return result;
    } catch (err) {
      console.error('[MeshCore] Telemetry error:', err);
      return null;
    }
  }, [state.connected]);

  return (
    <MeshCoreContext.Provider
      value={{
        ...state,
        scanForDevices,
        connectToDevice,
        disconnectDevice,
        sendMessage,
        sendChannelMessage,
        getContacts,
        getStatus,
        sendRawData,
        syncNextMessage,
        getChannel,
        setChannel,
        getBatteryVoltage,
        queryDevice,
        setAdvertName,
        setAdvertLatLon,
        setTxPower,
        setRadioParams,
        reboot,
        sendSelfAdvert,
        exportContact,
        removeContact,
        shareContact,
        login,
        requestTelemetry,
      }}
    >
      {children}
    </MeshCoreContext.Provider>
  );
}
