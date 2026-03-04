/**
 * BLE Provider
 *
 * Gère la connexion BLE au gateway ESP32 LoRa
 * Expose l'état BLE et les fonctions scan/connect/disconnect
 * 
 * V2.0: Utilise MessageRetryService pour persistance des messages
 */

import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Platform, PermissionsAndroid } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BleGatewayClient, getBleGatewayClient, BleGatewayDevice, BleDeviceInfo } from '@/utils/ble-gateway';
import { type MeshCorePacket } from '@/utils/meshcore-protocol';
import { getMessageRetryService } from '@/services/MessageRetryService';
import { getBackgroundBleService } from '@/services/BackgroundBleService';

const BLE_LAST_DEVICE_KEY = 'ble_last_device_id';

interface BleState {
  connected: boolean;
  loraActive: boolean;  // true = au moins un paquet LoRa reçu/envoyé avec succès
  device: BleGatewayDevice | null;
  deviceInfo: BleDeviceInfo | null;  // Infos parsées depuis SelfInfo (AppStart response)
  scanning: boolean;
  availableDevices: BleGatewayDevice[];
  error: string | null;
}

interface BleContextValue extends BleState {
  scanForGateways: () => Promise<void>;
  connectToGateway: (deviceId: string) => Promise<void>;
  disconnectGateway: () => Promise<void>;
  sendPacket: (packet: MeshCorePacket, timeoutMs?: number) => Promise<void>;
  onPacket: (handler: (packet: MeshCorePacket) => void) => void;
  confirmLoraActive: () => void;  // Appelé par MessagesProvider après réception d'un paquet BLE
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
    scanning: false,
    availableDevices: [],
    error: null,
  });

  const clientRef = useRef<BleGatewayClient | null>(null);
  const retryServiceRef = useRef(getMessageRetryService());
  // Handler en attente : enregistré avant que le client BLE soit initialisé
  const pendingPacketHandlerRef = useRef<((packet: MeshCorePacket) => void) | null>(null);
  // Ref pour accéder à state.connected dans les callbacks sans les recréer
  const connectedRef = useRef(false);
  useEffect(() => { connectedRef.current = state.connected; }, [state.connected]);

  useEffect(() => {
    // Initialiser le client BLE
    const initBle = async () => {
      try {
        // Demander les permissions BLE sur Android
        if (Platform.OS === 'android') {
          await requestAndroidPermissions();
        }

        const client = getBleGatewayClient();
        await client.initialize();
        clientRef.current = client;

        client.onDeviceInfo((info) => {
          setState((prev) => ({ ...prev, deviceInfo: info }));
        });

        // Appliquer tout handler enregistré avant l'initialisation
        if (pendingPacketHandlerRef.current) {
          client.onMessage((packet) => {
            setState((prev) => prev.loraActive ? prev : { ...prev, loraActive: true });
            pendingPacketHandlerRef.current?.(packet);
          });
          console.log('[BleProvider] Handler en attente appliqué après init BLE');
        }

        console.log('[BleProvider] BLE initialized');

        // Auto-reconnect au dernier appareil connu
        try {
          const lastDeviceId = await AsyncStorage.getItem(BLE_LAST_DEVICE_KEY);
          if (lastDeviceId) {
            console.log('[BleProvider] Auto-reconnect à:', lastDeviceId);
            await client.connect(lastDeviceId);
            const device = client.getConnectedDevice();
            setState((prev) => ({ ...prev, connected: true, device }));
            console.log('[BleProvider] Auto-reconnect réussi:', device?.name);
          }
        } catch (reconnectErr) {
          // Silencieux — l'appareil n'est peut-être pas à portée
          console.log('[BleProvider] Auto-reconnect échoué (appareil hors portée)');
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

    // Cleanup au démontage
    return () => {
      if (clientRef.current) {
        clientRef.current.disconnect().catch(console.error);
      }
      retryServiceRef.current.stop();
    };
  }, []);

  /**
   * Démarre le service de retry et le background service quand BLE se reconnecte
   */
  useEffect(() => {
    if (state.connected) {
      // Démarrer le service de retry
      retryServiceRef.current.start();
      
      // Enregistrer le background service
      getBackgroundBleService().register().catch(console.error);
      
      console.log('[BleProvider] Services démarrés');
    } else {
      retryServiceRef.current.stop();
    }
  }, [state.connected]);

  /**
   * Demande les permissions BLE sur Android
   */
  const requestAndroidPermissions = async () => {
    if (Platform.OS !== 'android') return;

    const apiLevel = Platform.Version;

    if (apiLevel >= 31) {
      // Android 12+ (API 31+)
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
      // Android <12
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );

      if (granted !== 'granted') {
        throw new Error('Location permission required for BLE scanning');
      }
    }
  };

  /**
   * Scanne les gateways BLE disponibles.
   * Si le client n'est pas encore initialisé (BT était off au démarrage),
   * on re-tente l'initialisation avant de lancer le scan.
   */
  const scanForGateways = useCallback(async () => {
    // Re-init si le client n'est pas prêt (BT off au démarrage, permissions tardives…)
    if (!clientRef.current) {
      try {
        if (Platform.OS === 'android') {
          await requestAndroidPermissions();
        }
        const client = getBleGatewayClient();
        await client.initialize();
        clientRef.current = client;
        client.onDeviceInfo((info) => {
          setState((prev) => ({ ...prev, deviceInfo: info }));
        });
        setState((prev) => ({ ...prev, error: null }));
      } catch (initErr: any) {
        const msg = initErr.message || 'Bluetooth non disponible';
        setState((prev) => ({ ...prev, error: msg }));
        throw new Error(msg);
      }
    }

    setState((prev) => ({ ...prev, scanning: true, availableDevices: [], error: null }));

    try {
      const foundDevices: BleGatewayDevice[] = [];

      await clientRef.current.scanForGateways((device) => {
        foundDevices.push(device);
        setState((prev) => ({
          ...prev,
          availableDevices: [...foundDevices],
        }));
      }, 10000); // 10s scan

      setState((prev) => ({ ...prev, scanning: false }));

      console.log(`[BleProvider] Scan complete: ${foundDevices.length} devices found`);
    } catch (error: any) {
      console.error('[BleProvider] Scan error:', error);
      setState((prev) => ({
        ...prev,
        scanning: false,
        error: error.message || 'Scan failed',
      }));
      throw error;
    }
  }, []);

  /**
   * Connecte à un gateway
   */
  const connectToGateway = useCallback(async (deviceId: string) => {
    if (!clientRef.current) {
      throw new Error('BLE not initialized');
    }

    setState((prev) => ({ ...prev, error: null }));

    const MAX_RETRIES = 3;
    const RETRY_DELAYS_MS = [1000, 2000, 4000]; // backoff exponentiel

    let lastError: any = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = RETRY_DELAYS_MS[attempt - 1];
          console.log(`[BleProvider] Retry ${attempt}/${MAX_RETRIES - 1} dans ${delay}ms…`);
          setState((prev) => ({
            ...prev,
            error: `Retry ${attempt}/${MAX_RETRIES - 1}…`,
          }));
          await new Promise((res) => setTimeout(res, delay));
          setState((prev) => ({ ...prev, error: null }));
        }

        await clientRef.current!.connect(deviceId);

        const device = clientRef.current!.getConnectedDevice();
        setState((prev) => ({ ...prev, connected: true, device }));

        // Persister l'ID pour auto-reconnect au prochain démarrage
        await AsyncStorage.setItem(BLE_LAST_DEVICE_KEY, deviceId);

        console.log(`[BleProvider] Connecté à ${device?.name} (tentative ${attempt + 1})`);
        return; // succès — sortir de la boucle

      } catch (error: any) {
        lastError = error;
        const msg: string = error?.message ?? String(error);

        // Erreur d'appairage : action utilisateur requise, inutile de retry
        const isAuthErr =
          msg.includes('133') ||
          msg.includes('insufficient') ||
          msg.includes('authentication') ||
          msg.includes('bonding') ||
          msg.includes('pairing');

        if (isAuthErr) {
          console.warn('[BleProvider] Erreur appairage — pas de retry automatique');
          setState((prev) => ({
            ...prev,
            error: 'Appairage BLE requis. Allez dans Paramètres → Bluetooth, supprimez "MeshCore-..." puis relancez.',
          }));
          throw error; // remonter immédiatement sans retry
        }

        console.warn(`[BleProvider] Échec tentative ${attempt + 1}/${MAX_RETRIES}:`, msg);
      }
    }

    // Toutes les tentatives épuisées
    const finalMsg: string = lastError?.message ?? String(lastError) ?? 'Connection failed';
    console.error(`[BleProvider] Connexion échouée après ${MAX_RETRIES} tentatives`);
    setState((prev) => ({ ...prev, error: finalMsg }));
    throw lastError;
  }, []);

  /**
   * Déconnecte du gateway
   */
  const disconnectGateway = useCallback(async () => {
    if (!clientRef.current) return;

    try {
      await clientRef.current.disconnect();

      // Effacer l'ID persisté (déconnexion volontaire = pas de reconnect)
      await AsyncStorage.removeItem(BLE_LAST_DEVICE_KEY);

      setState((prev) => ({
        ...prev,
        connected: false,
        loraActive: false,
        device: null,
      }));

      console.log('[BleProvider] Disconnected');
    } catch (error: any) {
      console.error('[BleProvider] Disconnect error:', error);
      setState((prev) => ({
        ...prev,
        error: error.message || 'Disconnect failed',
      }));
    }
  }, []);

  /**
   * Envoie un paquet MeshCore via BLE → LoRa avec timeout
   * Si déconnecté, ajoute à la file d'attente persistante
   */
  const sendPacket = useCallback(async (packet: MeshCorePacket, timeoutMs = 10000) => {
    if (!clientRef.current || !connectedRef.current) {
      // Si déconnecté, ajouter à la file persistante
      const msgId = `pending-${Date.now()}`;
      await retryServiceRef.current.queueMessage(msgId, packet);
      console.log(`[BleProvider] Message mis en file d'attente persistante: ${msgId}`);
      return;
    }

    try {
      // Timeout pour éviter le blocage
      await Promise.race([
        clientRef.current.sendPacket(packet),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('BLE timeout')), timeoutMs)
        )
      ]);
    } catch (error) {
      // En cas d'erreur, mettre en file d'attente pour retry
      const msgId = `retry-${Date.now()}`;
      await retryServiceRef.current.queueMessage(msgId, packet);
      console.log(`[BleProvider] Échec envoi, message en file d'attente: ${msgId}`);
      throw error;
    }
  }, []);

  /**
   * Enregistre un handler pour les paquets entrants.
   * Chaque appel remplace le handler précédent (design single-handler).
   */
  const onPacket = useCallback((handler: (packet: MeshCorePacket) => void) => {
    pendingPacketHandlerRef.current = handler;
    if (clientRef.current) {
      clientRef.current.onMessage((packet) => {
        setState((prev) => prev.loraActive ? prev : { ...prev, loraActive: true });
        pendingPacketHandlerRef.current?.(packet);
      });
    }
  }, []);

  /**
   * Marque explicitement LoRa comme actif
   */
  const confirmLoraActive = useCallback(() => {
    setState((prev) => prev.loraActive ? prev : { ...prev, loraActive: true });
  }, []);

  // Valeur stable : ne force pas de re-render des consommateurs si l'état n'a pas changé
  const contextValue = useMemo<BleContextValue>(() => ({
    ...state,
    scanForGateways,
    connectToGateway,
    disconnectGateway,
    sendPacket,
    onPacket,
    confirmLoraActive,
  }), [state, scanForGateways, connectToGateway, disconnectGateway, sendPacket, onPacket, confirmLoraActive]);

  return <BleContext.Provider value={contextValue}>{children}</BleContext.Provider>;
}
