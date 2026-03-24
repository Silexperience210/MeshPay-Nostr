/**
 * BLE Provider — MeshCore Companion Protocol v1.13
 *
 * Gère la connexion BLE au gateway MeshCore.
 * Expose : scan, connexion, envoi/réception messages, contacts, canaux.
 */

import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Platform, PermissionsAndroid, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BleGatewayClient,
  getBleGatewayClient,
  type BleGatewayDevice,
  type BleDeviceInfo,
  type MeshCoreContact,
  type MeshCoreIncomingMsg,
  type ChannelConfig,
} from '@/utils/ble-gateway';
import { type MeshCorePacket } from '@/utils/meshcore-protocol';
import { getMessageRetryService } from '@/services/MessageRetryService';
import { getBackgroundBleService } from '@/services/BackgroundBleService';

const BLE_LAST_DEVICE_KEY = 'ble_last_device_id';

interface BleState {
  connected: boolean;
  loraActive: boolean;
  device: BleGatewayDevice | null;
  deviceInfo: BleDeviceInfo | null;
  scanning: boolean;
  availableDevices: BleGatewayDevice[];
  error: string | null;
  // Protocole natif MeshCore Companion
  meshContacts: MeshCoreContact[];
  currentChannel: number;
  channelConfigured: boolean;
}

interface BleContextValue extends BleState {
  // Scan et connexion
  scanForGateways: () => Promise<void>;
  connectToGateway: (deviceId: string) => Promise<void>;
  disconnectGateway: () => Promise<void>;

  // BitMesh custom (CMD_SEND_RAW — firmware custom requis)
  sendPacket: (packet: MeshCorePacket, timeoutMs?: number) => Promise<void>;
  onPacket: (handler: (packet: MeshCorePacket) => void) => void;
  confirmLoraActive: () => void;

  // Protocole natif MeshCore Companion
  sendDirectMessage: (pubkeyHex: string, text: string) => Promise<void>;
  sendChannelMessage: (text: string) => Promise<void>;
  setChannel: (idx: number) => void;
  syncContacts: () => Promise<void>;
  sendSelfAdvert: () => Promise<void>;
  configureChannel: (index: number, name: string, secret: string) => Promise<void>;

  // Callbacks messages entrants et confirmations
  onBleMessage: (cb: (msg: MeshCoreIncomingMsg) => void) => () => void;
  offBleMessage: () => void;
  onSendConfirmed: (cb: (ackCode: number, roundTripMs: number) => void) => () => void;
}

const BleContext = createContext<BleContextValue | null>(null);

export function useBle(): BleContextValue {
  const ctx = useContext(BleContext);
  if (!ctx) throw new Error('useBle must be used within BleProvider');
  return ctx;
}

export function BleProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<BleState>({
    connected: false,
    loraActive: false,
    device: null,
    deviceInfo: null,
    scanning: false,
    availableDevices: [],
    error: null,
    meshContacts: [],
    currentChannel: 0,
    channelConfigured: false,
  });

  const clientRef     = useRef<BleGatewayClient | null>(null);
  const retryService  = useRef(getMessageRetryService());
  const pendingPacketHandlerRef = useRef<((packet: MeshCorePacket) => void) | null>(null);
  const incomingMsgCallbackRef  = useRef<((msg: MeshCoreIncomingMsg) => void) | null>(null);
  const connectedRef  = useRef(false);
  useEffect(() => { connectedRef.current = state.connected; }, [state.connected]);

  // ── Initialisation BLE ───────────────────────────────────────────

  useEffect(() => {
    const init = async () => {
      try {
        if (Platform.OS === 'android') {
          try { await requestAndroidPermissions(); }
          catch (e) { console.warn('[BleProvider] Permissions BLE non accordées:', e); }
        }

        const client = getBleGatewayClient();
        await client.initialize();
        clientRef.current = client;

        // SelfInfo reçue → device info + nom à jour
        client.onDeviceInfo((info) => {
          console.log('[BleProvider] SelfInfo reçue:', info.name);
          setState((prev) => ({
            ...prev,
            deviceInfo: info,
            device: prev.device ? { ...prev.device, name: info.name } : null,
          }));
        });

        // Message texte reçu via protocole Companion (DM ou canal)
        client.onIncomingMessage((msg) => {
          console.log(`[BleProvider] Message ${msg.type} reçu: "${msg.text.slice(0, 30)}"`);
          setState((prev) => ({ ...prev, loraActive: true }));
          incomingMsgCallbackRef.current?.(msg);
        });

        // Contact découvert (PUSH_ADVERT ou PUSH_NEW_ADVERT)
        client.onContactDiscovered((contact) => {
          setState((prev) => ({
            ...prev,
            meshContacts: [
              ...prev.meshContacts.filter((c) => c.pubkeyHex !== contact.pubkeyHex),
              contact,
            ],
          }));
        });

        // Liste complète contacts chargée (fin CMD_GET_CONTACTS)
        client.onContacts((contacts) => {
          console.log(`[BleProvider] ${contacts.length} contacts chargés`);
          setState((prev) => ({ ...prev, meshContacts: contacts }));
        });

        // Livraison LoRa confirmée (PUSH_SEND_CONFIRMED)
        client.onSendConfirmed((ackCode, rtt) => {
          console.log(`[BleProvider] Message confirmé ACK:${ackCode} RTT:${rtt}ms`);
        });

        // Déconnexion détectée par le firmware
        client.onDisconnect(() => {
          console.log('[BleProvider] Déconnexion détectée');
          setState((prev) => ({
            ...prev,
            connected: false,
            loraActive: false,
            device: null,
            meshContacts: [],
            channelConfigured: false,
          }));
        });

        // Appliquer handler en attente (enregistré avant init)
        if (pendingPacketHandlerRef.current) {
          client.onMessage((packet) => {
            setState((prev) => (prev.loraActive ? prev : { ...prev, loraActive: true }));
            pendingPacketHandlerRef.current?.(packet);
          });
        }

        console.log('[BleProvider] BLE initialisé');

        // Auto-reconnect au dernier device connu
        try {
          const lastId = await AsyncStorage.getItem(BLE_LAST_DEVICE_KEY);
          if (lastId) {
            console.log('[BleProvider] Auto-reconnect:', lastId);
            await Promise.race([
              client.connect(lastId),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('auto-reconnect timeout')), 10000)
              ),
            ]);
            const device = client.getConnectedDevice();
            const ch0    = client.getChannelConfig(0);
            setState((prev) => ({
              ...prev,
              connected: true,
              device,
              channelConfigured: ch0?.configured || false,
            }));
            console.log('[BleProvider] Auto-reconnect réussi:', device?.name);
          }
        } catch {
          console.log('[BleProvider] Auto-reconnect échoué');
        }
      } catch (err: any) {
        console.error('[BleProvider] Init error:', err);
        setState((prev) => ({ ...prev, error: err.message || 'BLE init failed' }));
      }
    };

    init();
    return () => {
      clientRef.current?.disconnect().catch(console.error);
      retryService.current.stop();
    };
  }, []);

  useEffect(() => {
    if (state.connected) {
      retryService.current.start();
      getBackgroundBleService().register().catch(console.error);
    } else {
      retryService.current.stop();
    }
  }, [state.connected]);

  // ── Permissions Android ──────────────────────────────────────────

  const requestAndroidPermissions = async () => {
    if (Platform.OS !== 'android') return;
    if ((Platform.Version as number) >= 31) {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      if (
        granted['android.permission.BLUETOOTH_SCAN'] !== 'granted' ||
        granted['android.permission.BLUETOOTH_CONNECT'] !== 'granted'
      ) throw new Error('BLE permissions not granted');
    } else {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );
      if (granted !== 'granted') throw new Error('Location permission required for BLE scanning');
    }
  };

  // ── Scan ─────────────────────────────────────────────────────────

  const scanForGateways = useCallback(async () => {
    if (!clientRef.current) {
      try {
        if (Platform.OS === 'android') await requestAndroidPermissions();
        const client = getBleGatewayClient();
        await client.initialize();
        clientRef.current = client;
        client.onDeviceInfo((info) => setState((p) => ({ ...p, deviceInfo: info })));
        setState((p) => ({ ...p, error: null }));
      } catch (e: any) {
        const msg = e.message || 'Bluetooth non disponible';
        setState((p) => ({ ...p, error: msg }));
        throw new Error(msg);
      }
    }

    setState((p) => ({ ...p, scanning: true, availableDevices: [], error: null }));
    try {
      const found: BleGatewayDevice[] = [];
      await clientRef.current!.scanForGateways((device) => {
        found.push(device);
        setState((p) => ({ ...p, availableDevices: [...found] }));
      }, 10000);
      setState((p) => ({ ...p, scanning: false }));
      console.log(`[BleProvider] Scan terminé: ${found.length} device(s)`);
    } catch (err: any) {
      setState((p) => ({ ...p, scanning: false, error: err.message || 'Scan failed' }));
      throw err;
    }
  }, []);

  // ── Connexion ────────────────────────────────────────────────────

  const connectToGateway = useCallback(async (deviceId: string) => {
    if (!clientRef.current) throw new Error('BLE non initialisé');
    setState((p) => ({ ...p, error: null }));

    const MAX_RETRIES = 3;
    const DELAYS      = [1000, 2000, 4000];
    let lastError: any;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = DELAYS[attempt - 1];
          console.log(`[BleProvider] Retry ${attempt}/${MAX_RETRIES - 1} dans ${delay}ms...`);
          setState((p) => ({ ...p, error: `Retry ${attempt}/${MAX_RETRIES - 1}...` }));
          await new Promise((r) => setTimeout(r, delay));
          setState((p) => ({ ...p, error: null }));
        }

        await clientRef.current!.connect(deviceId);

        const device = clientRef.current!.getConnectedDevice();
        const ch0    = clientRef.current!.getChannelConfig(0);
        setState((p) => ({
          ...p,
          connected: true,
          device,
          meshContacts: [],
          channelConfigured: ch0?.configured || false,
        }));
        await AsyncStorage.setItem(BLE_LAST_DEVICE_KEY, deviceId);
        console.log(`[BleProvider] Connecté à ${device?.name}`);
        return;
      } catch (err: any) {
        lastError = err;
        const msg = String(err?.message ?? err ?? '').toLowerCase();
        const isAuthErr =
          msg.includes('133') || msg.includes('insufficient') ||
          msg.includes('authentication') || msg.includes('bonding') || msg.includes('pairing');
        if (isAuthErr) {
          setState((p) => ({ ...p, error: 'Erreur appairage BLE. Vérifiez le PIN (défaut: 123456).' }));
          throw err;
        }
        console.warn(`[BleProvider] Tentative ${attempt + 1}/${MAX_RETRIES} échouée:`, msg);
      }
    }

    const finalMsg = lastError?.message ?? String(lastError) ?? 'Connection failed';
    setState((p) => ({ ...p, error: finalMsg }));
    throw lastError;
  }, []);

  // ── Déconnexion ──────────────────────────────────────────────────

  const disconnectGateway = useCallback(async () => {
    if (!clientRef.current) return;
    try {
      await clientRef.current.disconnect();
      await AsyncStorage.removeItem(BLE_LAST_DEVICE_KEY);
      setState((p) => ({
        ...p,
        connected: false,
        loraActive: false,
        device: null,
        meshContacts: [],
        currentChannel: 0,
        channelConfigured: false,
      }));
      console.log('[BleProvider] Déconnecté');
    } catch (err: any) {
      setState((p) => ({ ...p, error: err.message || 'Disconnect failed' }));
    }
  }, []);

  // ── BitMesh custom (CMD_SEND_RAW) ────────────────────────────────

  const sendPacket = useCallback(async (packet: MeshCorePacket, timeoutMs = 10000) => {
    if (!clientRef.current || !connectedRef.current) {
      const msgId = `pending-${Date.now()}`;
      await retryService.current.queueMessage(msgId, packet);
      console.log(`[BleProvider] Message en file d'attente: ${msgId}`);
      return;
    }
    try {
      await Promise.race([
        clientRef.current.sendPacket(packet),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('BLE timeout')), timeoutMs)),
      ]);
    } catch (err) {
      const msgId = `retry-${Date.now()}`;
      await retryService.current.queueMessage(msgId, packet);
      throw err;
    }
  }, []);

  const onPacket = useCallback((handler: (packet: MeshCorePacket) => void) => {
    pendingPacketHandlerRef.current = handler;
    if (clientRef.current) {
      clientRef.current.onMessage((packet) => {
        setState((p) => (p.loraActive ? p : { ...p, loraActive: true }));
        pendingPacketHandlerRef.current?.(packet);
      });
    }
  }, []);

  const confirmLoraActive = useCallback(() => {
    setState((p) => (p.loraActive ? p : { ...p, loraActive: true }));
  }, []);

  // ── Protocole natif MeshCore Companion ──────────────────────────

  const sendDirectMessage = useCallback(async (pubkeyHex: string, text: string) => {
    if (!clientRef.current || !connectedRef.current) throw new Error('BLE non connecté');
    const hexClean = pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
    if (!/^[0-9a-fA-F]{12,}$/.test(hexClean)) throw new Error('Clé publique invalide');
    await clientRef.current.sendDirectMessage(hexClean, text);
    setState((p) => (p.loraActive ? p : { ...p, loraActive: true }));
  }, []);

  const sendChannelMessage = useCallback(async (text: string) => {
    if (!clientRef.current || !connectedRef.current) throw new Error('BLE non connecté');
    await clientRef.current.sendChannelMessage(state.currentChannel, text);
    setState((p) => (p.loraActive ? p : { ...p, loraActive: true }));
  }, [state.currentChannel]);

  const setChannel = useCallback((idx: number) => {
    setState((p) => ({
      ...p,
      currentChannel: idx,
      channelConfigured: clientRef.current?.getChannelConfig(idx)?.configured || false,
    }));
  }, []);

  const syncContacts = useCallback(async () => {
    if (!clientRef.current || !connectedRef.current) return;
    await clientRef.current.getContacts();
  }, []);

  const sendSelfAdvert = useCallback(async () => {
    if (!clientRef.current || !connectedRef.current) return;
    await clientRef.current.sendSelfAdvert(1);
  }, []);

  const configureChannel = useCallback(async (index: number, name: string, secret: string) => {
    if (!clientRef.current || !connectedRef.current) throw new Error('BLE non connecté');
    const secretBytes = new Uint8Array(32);
    const encoded     = new TextEncoder().encode(secret);
    secretBytes.set(encoded.slice(0, 32));
    await clientRef.current.setChannel(index, name, secretBytes);
    if (index === state.currentChannel) {
      setState((p) => ({ ...p, channelConfigured: true }));
    }
  }, [state.currentChannel]);

  // ── Callbacks messages entrants ──────────────────────────────────

  const onBleMessage = useCallback((cb: (msg: MeshCoreIncomingMsg) => void): (() => void) => {
    incomingMsgCallbackRef.current = cb;
    return () => { incomingMsgCallbackRef.current = null; };
  }, []);

  const offBleMessage = useCallback(() => {
    incomingMsgCallbackRef.current = null;
  }, []);

  const onSendConfirmed = useCallback((cb: (ackCode: number, rtt: number) => void): (() => void) => {
    clientRef.current?.onSendConfirmed(cb);
    return () => { clientRef.current?.onSendConfirmed(() => {}); };
  }, []);

  // ── Context value ─────────────────────────────────────────────────

  const contextValue = useMemo<BleContextValue>(() => ({
    ...state,
    scanForGateways,
    connectToGateway,
    disconnectGateway,
    sendPacket,
    onPacket,
    confirmLoraActive,
    sendDirectMessage,
    sendChannelMessage,
    setChannel,
    syncContacts,
    sendSelfAdvert,
    configureChannel,
    onBleMessage,
    offBleMessage,
    onSendConfirmed,
  }), [
    state,
    scanForGateways, connectToGateway, disconnectGateway,
    sendPacket, onPacket, confirmLoraActive,
    sendDirectMessage, sendChannelMessage, setChannel,
    syncContacts, sendSelfAdvert, configureChannel,
    onBleMessage, offBleMessage, onSendConfirmed,
  ]);

  return <BleContext.Provider value={contextValue}>{children}</BleContext.Provider>;
}
