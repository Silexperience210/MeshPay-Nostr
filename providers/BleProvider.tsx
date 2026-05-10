/**
 * BLE Provider
 *
 * Gère la connexion BLE au gateway ESP32 LoRa
 * Expose l'état BLE et les fonctions scan/connect/disconnect
 *
 * V3.0: Protocole natif MeshCore Companion (CMD_SEND_TXT_MSG, channels, contacts)
 */

import React, { createContext, useContext, useState, useEffect, useRef, useMemo } from 'react';
import { Platform, PermissionsAndroid } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BleManager from 'react-native-ble-manager';
import {
  BleGatewayClient,
  getBleGatewayClient,
  BleGatewayDevice,
  BleDeviceInfo,
  MeshCoreContact,
  MeshCoreIncomingMsg,
  MeshCoreStats,
  MeshCoreNeighbour,
  MeshCoreStatusResponse,
} from '@/utils/ble-gateway';
import { type MeshCorePacket } from '@/utils/meshcore-protocol';
import { getMessageRetryService } from '@/services/MessageRetryService';
import { getBackgroundBleService } from '@/services/BackgroundBleService';
import { updateMessageStatusDB, removePendingMessage } from '@/utils/database';

const BLE_LAST_DEVICE_KEY = 'ble_last_device_id';

interface BleState {
  connected: boolean;
  loraActive: boolean;  // true = au moins un paquet LoRa reçu/envoyé avec succès
  device: BleGatewayDevice | null;
  deviceInfo: BleDeviceInfo | null;
  error: string | null;
  currentChannel: number;          // 0=public, 1-N=privé chiffré
  meshContacts: MeshCoreContact[]; // contacts syncés du device MeshCore
  batteryVolts: number | null;     // tension batterie gateway (V)
  neighbours: MeshCoreNeighbour[]; // voisins directs (1-hop)
  allStats: Record<string, MeshCoreStats>; // stats par type: 'core'|'radio'|'packets'
}

interface BleContextValue extends BleState {
  connectToGateway: (deviceId: string) => Promise<void>;
  disconnectGateway: () => Promise<void>;
  sendPacket: (packet: MeshCorePacket, timeoutMs?: number, localMsgId?: string) => Promise<void>;
  onPacket: (handler: (packet: MeshCorePacket) => void) => void;
  confirmLoraActive: () => void;
  // Protocole natif MeshCore Companion — messages
  // localMsgId : DBMessage.id, propagé jusqu'à PUSH_SEND_CONFIRMED via expected_ack
  sendDirectMessage: (pubkeyHex: string, text: string, localMsgId?: string) => Promise<void>;
  sendChannelMessage: (text: string, localMsgId?: string) => Promise<void>; // utilise currentChannel
  sendChannelData: (dataType: number, payload: Uint8Array) => Promise<void>; // v1.15.0+
  setChannel: (idx: number) => void;
  syncContacts: () => Promise<void>;
  sendSelfAdvert: () => Promise<void>;
  onBleMessage: (cb: (msg: MeshCoreIncomingMsg) => void) => void;
  // ACK firmware (multi-listener — utilisé par MessagesProvider pour MAJ React state)
  onSendConfirmed: (cb: (localMsgId: string | null, ackCode: number, rtt: number) => void) => () => void;
  onMessageAccepted: (cb: (localMsgId: string, expectedAck: number, estTimeoutMs: number, isFlood: boolean) => void) => () => void;
  // Protocole natif MeshCore Companion — device settings
  setAdvertName: (name: string) => Promise<void>;
  setTxPower: (dbm: number) => Promise<void>;
  setRadioParams: (freqHz: number, bwHz: number, sf: number, cr: number) => Promise<void>;
  setAdvertLatLon: (lat: number, lon: number) => Promise<void>;
  setFloodScope: (region: string | null) => Promise<void>;
  reboot: () => Promise<void>;
  getBattery: () => Promise<void>;
  getStats: (type?: 0 | 1 | 2) => Promise<void>;
  getNeighbours: () => Promise<void>;
  // Protocole natif MeshCore Companion — contacts
  resetPath: (pubkeyHex: string) => Promise<void>;
  removeContact: (pubkeyHex: string) => Promise<void>;
  exportContact: (pubkeyHex: string) => Promise<void>;
  sendStatusReq: (pubkeyHex: string) => Promise<void>;
  sendLogin: (pubkeyHex: string, password: string) => Promise<void>;
}

const BleContext = createContext<BleContextValue | null>(null);

export function useBle(): BleContextValue {
  const context = useContext(BleContext);
  if (!context) {
    throw new Error('useBle must be used within BleProvider');
  }
  return context;
}

export function BleProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<BleState>({
    connected: false,
    loraActive: false,
    device: null,
    deviceInfo: null,
    error: null,
    currentChannel: 0,
    meshContacts: [],
    batteryVolts: null,
    neighbours: [],
    allStats: {},
  });

  const clientRef = useRef<BleGatewayClient | null>(null);
  const retryServiceRef = useRef(getMessageRetryService());
  const incomingMessageCallbackRef = useRef<((msg: MeshCoreIncomingMsg) => void) | null>(null);

  // Listeners ACK pour MessagesProvider (callback BLE single-slot → fan-out manuel ici)
  const sendConfirmedListenersRef = useRef<Set<(localMsgId: string | null, ackCode: number, rtt: number) => void>>(new Set());
  const messageAcceptedListenersRef = useRef<Set<(localMsgId: string, expectedAck: number, estTimeoutMs: number, isFlood: boolean) => void>>(new Set());

  useEffect(() => {
    const initBle = async () => {
      try {
        if (Platform.OS === 'android') {
          try {
            await requestAndroidPermissions();
          } catch (permErr) {
            // Permissions refusées au démarrage — on continue quand même l'init BLE.
            // Elles seront re-demandées lors du premier scan dans GatewayScanModal.
            console.warn('[BleProvider] Permissions BLE non accordées au lancement:', permErr);
          }
        }

        const client = getBleGatewayClient();
        await client.initialize();
        clientRef.current = client;

        client.onDeviceInfo((info) => {
          setState((prev) => ({ ...prev, deviceInfo: info }));
        });

        // Callback : message direct ou channel reçu via firmware natif
        client.onIncomingMessage((msg) => {
          setState((prev) => prev.loraActive ? prev : { ...prev, loraActive: true });
          incomingMessageCallbackRef.current?.(msg);
        });

        // Callback : nœud découvert via PUSH_ADVERT
        client.onContactDiscovered((contact) => {
          setState((prev) => ({
            ...prev,
            meshContacts: [
              ...prev.meshContacts.filter(c => c.pubkeyHex !== contact.pubkeyHex),
              contact,
            ],
          }));
        });

        // Callback : liste complète des contacts chargée depuis le device
        client.onContacts((contacts) => {
          console.log(`[BleProvider] ${contacts.length} contacts chargés depuis device`);
          setState((prev) => ({ ...prev, meshContacts: contacts }));
        });

        // Callback : firmware a accepté le message (RESP_SENT) → status « sent »
        // (BLE → LoRa OK, en attente d'ACK distant). Persiste en DB et fan-out
        // vers les listeners React (MessagesProvider).
        client.onMessageAccepted((localMsgId, expectedAck, estTimeoutMs, isFlood) => {
          console.log(`[BleProvider] RESP_SENT msgId=${localMsgId} ack=0x${expectedAck.toString(16)} timeout=${estTimeoutMs}ms ${isFlood ? 'flood' : 'direct'}`);
          updateMessageStatusDB(localMsgId, 'sent').catch((e) =>
            console.warn('[BleProvider] updateMessageStatusDB(sent) failed:', e)
          );
          for (const cb of messageAcceptedListenersRef.current) {
            try { cb(localMsgId, expectedAck, estTimeoutMs, isFlood); } catch (e) {
              console.error('[BleProvider] messageAccepted listener error:', e);
            }
          }
        });

        // Callback : firmware confirme la livraison LoRa (PUSH_SEND_CONFIRMED)
        // → status « delivered ». Persiste en DB, retire de la file de retry et
        // fan-out vers les listeners React.
        client.onSendConfirmed((localMsgId, ackCode, rtt) => {
          console.log(`[BleProvider] PUSH_SEND_CONFIRMED ack=0x${ackCode.toString(16)} RTT:${rtt}ms${localMsgId ? ` msgId=${localMsgId}` : ' (orphelin)'}`);
          if (localMsgId) {
            updateMessageStatusDB(localMsgId, 'delivered').catch((e) =>
              console.warn('[BleProvider] updateMessageStatusDB(delivered) failed:', e)
            );
            removePendingMessage(localMsgId).catch(() => { /* peut ne plus exister, OK */ });
          }
          for (const cb of sendConfirmedListenersRef.current) {
            try { cb(localMsgId, ackCode, rtt); } catch (e) {
              console.error('[BleProvider] sendConfirmed listener error:', e);
            }
          }
        });

        // Callback : batterie
        client.onBattery((volts) => {
          setState((prev) => ({ ...prev, batteryVolts: volts }));
        });

        // Callback : stats — stockées par type pour ne pas écraser les autres
        client.onStats((stats) => {
          setState((prev) => ({ ...prev, allStats: { ...prev.allStats, [stats.type]: stats } }));
        });

        // Callback : voisins
        client.onNeighbours((neighbours) => {
          setState((prev) => ({ ...prev, neighbours }));
        });

        // Callback : path updated
        client.onPathUpdated((prefix) => {
          console.log(`[BleProvider] Path mis à jour pour ${prefix}`);
        });

        // Callback : login result room server
        client.onLoginResult((success) => {
          console.log(`[BleProvider] Login room server: ${success ? 'OK' : 'FAIL'}`);
        });

        // Callback : déconnexion BLE — met à jour l'état React
        client.onDisconnect(() => {
          console.log('[BleProvider] Déconnexion détectée — reset état');
          setState((prev) => ({
            ...prev,
            connected: false,
            loraActive: false,
            device: null,
          }));
        });

        console.log('[BleProvider] BLE initialized');

        // Auto-reconnect avec timeout court (8s max) pour ne pas bloquer le scan
        // Android interdit le scan pendant connect()/bonding → timeout impératif
        let lastDeviceId: string | null = null;
        let reconnectTimeout: NodeJS.Timeout | null = null;
        let isReconnected = false;
        
        try {
          lastDeviceId = await AsyncStorage.getItem(BLE_LAST_DEVICE_KEY);
          if (lastDeviceId) {
            console.log('[BleProvider] Auto-reconnect à:', lastDeviceId);
            
            // Race condition fix: utiliser un flag pour éviter les états inconsistants
            const connectPromise = client.connect(lastDeviceId).then(() => {
              isReconnected = true;
              if (reconnectTimeout) clearTimeout(reconnectTimeout);
            });
            
            const timeoutPromise = new Promise<never>((_, reject) => {
              reconnectTimeout = setTimeout(() => {
                if (!isReconnected) {
                  reject(new Error('auto-reconnect timeout'));
                }
              }, 8000);
            });
            
            await Promise.race([connectPromise, timeoutPromise]);
            
            if (isReconnected) {
              const device = client.getConnectedDevice();
              setState((prev) => ({ ...prev, connected: true, device }));
              console.log('[BleProvider] Auto-reconnect réussi:', device?.name);
            }
          }
        } catch (reconnectErr) {
          console.log('[BleProvider] Auto-reconnect échoué — nettoyage');
          // Nettoyage du timeout
          if (reconnectTimeout) clearTimeout(reconnectTimeout);
          
          // Forcer la déconnexion même si connectedId n'est pas encore set
          // (BleManager.connect() peut encore tourner en background sinon)
          if (lastDeviceId) {
            BleManager.disconnect(lastDeviceId).catch(() => { /* cleanup: ignore */ });
          }
          client.disconnect().catch(() => { /* cleanup: ignore */ });
        }
      } catch (error: any) {
        console.error('[BleProvider] Initialization error:', error);
        setState((prev) => ({
          ...prev,
          error: error.message || 'Failed to initialize BLE',
        }));
      }
    };

    initBle();

    return () => {
      if (clientRef.current) {
        clientRef.current.disconnect().catch(console.error);
      }
      retryServiceRef.current.stop();
      // Libérer le service background pour ne pas laisser un polling + AppState
      // listener actifs si le Provider se démonte (hot reload, logout, etc.)
      getBackgroundBleService().stop().catch(console.error);
    };
  }, []);

  useEffect(() => {
    if (state.connected) {
      retryServiceRef.current.start();
      getBackgroundBleService().register().catch(console.error);
      if (__DEV__) console.log('[BleProvider] Services démarrés');
    } else {
      retryServiceRef.current.stop();
    }
  }, [state.connected]);

  const requestAndroidPermissions = async () => {
    if (Platform.OS !== 'android') return;

    const apiLevel = Platform.Version;

    if (apiLevel >= 31) {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);

      if (
        granted['android.permission.BLUETOOTH_SCAN'] !== 'granted' ||
        granted['android.permission.BLUETOOTH_CONNECT'] !== 'granted'
      ) {
        throw new Error('BLE permissions not granted');
      }
    } else {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );

      if (granted !== 'granted') {
        throw new Error('Location permission required for BLE scanning');
      }
    }
  };

  const connectToGateway = async (deviceId: string) => {
    if (!clientRef.current) {
      throw new Error('BLE not initialized');
    }

    setState((prev) => ({ ...prev, error: null }));

    try {
      await clientRef.current.connect(deviceId);

      const device = clientRef.current.getConnectedDevice();

      setState((prev) => ({
        ...prev,
        connected: true,
        device,
        meshContacts: [], // Reset contacts, seront rechargés via getContacts()
      }));

      await AsyncStorage.setItem(BLE_LAST_DEVICE_KEY, deviceId);
      console.log(`[BleProvider] Connected to ${device?.name}`);
    } catch (error: any) {
      console.error('[BleProvider] Connection error:', error);
      const msg: string = error?.message ?? String(error);
      const isAuthErr =
        msg.includes('133') ||
        msg.includes('insufficient') ||
        msg.includes('authentication') ||
        msg.includes('bonding') ||
        msg.includes('pairing');
      const displayMsg = isAuthErr
        ? 'Erreur d\'appairage BLE. Vérifiez le PIN dans le modal de scan (défaut: 123456).'
        : msg || 'Connection failed';
      setState((prev) => ({ ...prev, error: displayMsg }));
      throw error;
    }
  };

  const disconnectGateway = async () => {
    if (!clientRef.current) return;

    try {
      await clientRef.current.disconnect();
      await AsyncStorage.removeItem(BLE_LAST_DEVICE_KEY);

      setState((prev) => ({
        ...prev,
        connected: false,
        loraActive: false,
        device: null,
        meshContacts: [],
        currentChannel: 0,
      }));

      console.log('[BleProvider] Disconnected');
    } catch (error: any) {
      console.error('[BleProvider] Disconnect error:', error);
      setState((prev) => ({
        ...prev,
        error: error.message || 'Disconnect failed',
      }));
    }
  };

  const sendPacket = async (packet: MeshCorePacket, timeoutMs = 10000, localMsgId?: string) => {
    if (!clientRef.current || !state.connected) {
      const msgId = localMsgId || `pending-${Date.now()}`;
      await retryServiceRef.current.queueMessage(msgId, packet);
      console.log(`[BleProvider] Message mis en file d'attente persistante: ${msgId}`);
      return;
    }

    try {
      await Promise.race([
        clientRef.current.sendPacket(packet),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('BLE timeout')), timeoutMs)
        )
      ]);
    } catch (error) {
      const msgId = localMsgId || `retry-${Date.now()}`;
      await retryServiceRef.current.queueMessage(msgId, packet);
      console.log(`[BleProvider] Échec envoi, message en file d'attente: ${msgId}`);
      throw error;
    }
  };

  const onPacket = (handler: (packet: MeshCorePacket) => void) => {
    if (clientRef.current) {
      clientRef.current.onMessage((packet) => {
        setState((prev) => prev.loraActive ? prev : { ...prev, loraActive: true });
        handler(packet);
      });
    }
  };

  const confirmLoraActive = () => {
    setState((prev) => prev.loraActive ? prev : { ...prev, loraActive: true });
  };

  // ── Protocole natif MeshCore Companion ─────────────────────────

  const sendDirectMessage = async (pubkeyHex: string, text: string, localMsgId?: string) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    const hexClean = pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
    await clientRef.current.sendDirectMessage(hexClean, text, 0, localMsgId);
    setState((prev) => prev.loraActive ? prev : { ...prev, loraActive: true });
  };

  const sendChannelMessage = async (text: string, localMsgId?: string) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.sendChannelMessage(state.currentChannel, text, localMsgId);
    setState((prev) => prev.loraActive ? prev : { ...prev, loraActive: true });
  };

  // Multi-listener pour le ACK firmware. Le client BLE expose un seul slot
  // (this.sendConfirmedCallback) — câblé une fois dans BleProvider lors de l'init,
  // qui fan-out manuellement vers les abonnés enregistrés ici.
  const onSendConfirmed = (cb: (localMsgId: string | null, ackCode: number, rtt: number) => void) => {
    sendConfirmedListenersRef.current.add(cb);
    return () => { sendConfirmedListenersRef.current.delete(cb); };
  };

  const onMessageAccepted = (cb: (localMsgId: string, expectedAck: number, estTimeoutMs: number, isFlood: boolean) => void) => {
    messageAcceptedListenersRef.current.add(cb);
    return () => { messageAcceptedListenersRef.current.delete(cb); };
  };

  const sendChannelData = async (dataType: number, payload: Uint8Array) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.sendChannelData(state.currentChannel, dataType, payload);
    setState((prev) => prev.loraActive ? prev : { ...prev, loraActive: true });
  };

  const setChannel = (idx: number) => {
    setState((prev) => ({ ...prev, currentChannel: idx }));
    console.log(`[BleProvider] Channel → ch${idx}`);
  };

  const syncContacts = async () => {
    if (!clientRef.current || !state.connected) return;
    await clientRef.current.getContacts();
  };

  const sendSelfAdvert = async () => {
    if (!clientRef.current || !state.connected) return;
    await clientRef.current.sendSelfAdvert(1);
  };

  const onBleMessage = (cb: (msg: MeshCoreIncomingMsg) => void) => {
    incomingMessageCallbackRef.current = cb;
  };

  // ── Device settings ──────────────────────────────────────────────

  const setAdvertName = async (name: string) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.setAdvertName(name);
  };

  const setTxPower = async (dbm: number) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.setTxPower(dbm);
  };

  const setRadioParams = async (freqHz: number, bwHz: number, sf: number, cr: number) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.setRadioParams(freqHz, bwHz, sf, cr);
  };

  const setAdvertLatLon = async (lat: number, lon: number) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.setAdvertLatLon(lat, lon);
  };

  const setFloodScope = async (region: string | null) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.setFloodScope(region);
  };

  const reboot = async () => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.reboot();
  };

  const getBattery = async () => {
    if (!clientRef.current || !state.connected) return;
    await clientRef.current.getBattery();
  };

  const getStats = async (type: 0 | 1 | 2 = 0) => {
    if (!clientRef.current || !state.connected) return;
    await clientRef.current.getStats(type);
  };

  const getNeighbours = async () => {
    if (!clientRef.current || !state.connected) return;
    await clientRef.current.getNeighbours();
  };

  // ── Contact actions ──────────────────────────────────────────────

  const resetPath = async (pubkeyHex: string) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.resetPath(pubkeyHex);
  };

  const removeContact = async (pubkeyHex: string) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.removeContact(pubkeyHex);
    // Retirer du state local
    setState((prev) => ({
      ...prev,
      meshContacts: prev.meshContacts.filter((c) => c.pubkeyHex !== pubkeyHex),
    }));
  };

  const exportContact = async (pubkeyHex: string) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.exportContact(pubkeyHex);
  };

  const sendStatusReq = async (pubkeyHex: string) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.sendStatusReq(pubkeyHex);
  };

  const sendLogin = async (pubkeyHex: string, password: string) => {
    if (!clientRef.current || !state.connected) throw new Error('BLE non connecté');
    await clientRef.current.sendLogin(pubkeyHex, password);
  };

  const contextValue: BleContextValue = useMemo(() => ({
    ...state,
    connectToGateway,
    disconnectGateway,
    sendPacket,
    onPacket,
    confirmLoraActive,
    sendDirectMessage,
    sendChannelMessage,
    sendChannelData,
    setChannel,
    syncContacts,
    sendSelfAdvert,
    setAdvertName,
    setTxPower,
    setRadioParams,
    setAdvertLatLon,
    setFloodScope,
    reboot,
    getBattery,
    getStats,
    getNeighbours,
    resetPath,
    removeContact,
    exportContact,
    sendStatusReq,
    sendLogin,
    onBleMessage,
    onSendConfirmed,
    onMessageAccepted,
  }), [state]);

  return <BleContext.Provider value={contextValue}>{children}</BleContext.Provider>;
}
