/**
 * BLE Gateway Client — MeshCore Companion Protocol (v1.13 / v1.14 / v1.15)
 *
 * Bibliothèque : react-native-ble-manager (v12+)
 *
 * Sources de vérité :
 *   https://github.com/zjs81/meshcore-open         (Flutter officiel)
 *   meshcore_firmware/examples/companion_radio/MyMesh.cpp (tag companion-v1.15.0)
 *   meshcore_firmware/docs/companion_protocol.md
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  PROTOCOLE BLE — Nordic UART Service (NUS)                          ║
 * ║  App → Device : [cmd][payload...]   sur 6e400002 (RX/write)         ║
 * ║  Device → App : [code][data...]     sur 6e400003 (TX/notify)        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Séquence connexion (source : docs/companion_protocol.md §5 "Send Initial Commands") :
 *   1. connect() + requestMTU(185)
 *   2. retrieveServices()
 *   3. createBond() — bonding explicite PIN Android
 *   4. startNotification() sur RX (6e400003) — avec retry
 *   5. AppStart     (cmd=1)  → device répond SelfInfo (code=5)   ← DOIT être envoyé EN PREMIER
 *   6. DeviceQuery  (cmd=22) [version=3] → device répond DeviceInfo (code=13)
 *   7. SetTime      (cmd=6)  envoyé auto dans parseSelfInfo
 *   8. configureDefaultChannels() — canal 0 public
 *   9. getContacts() — liste tous les nœuds connus
 *  10. sendSelfAdvert() — annonce notre présence sur le mesh
 */

import BleManager from 'react-native-ble-manager';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import {
  MESHCORE_BLE,
  type MeshCorePacket,
  encodeMeshCorePacket,
  decodeMeshCorePacket,
} from './meshcore-protocol';

// ── Nordic UART Service UUIDs ──────────────────────────────────────────
const SERVICE_UUID = MESHCORE_BLE.SERVICE_UUID; // 6e400001-b5a3-f393-e0a9-e50e24dcca9e
const TX_UUID      = MESHCORE_BLE.TX_CHAR_UUID; // 6e400002  App → Device (WRITE)
const RX_UUID      = MESHCORE_BLE.RX_CHAR_UUID; // 6e400003  Device → App (NOTIFY)

// ── Command codes (App → Device) ──────────────────────────────────────
const CMD_APP_START         = 1;   // Handshake principal
const CMD_SEND_TXT_MSG      = 2;   // DM texte → routing firmware standard
const CMD_SEND_CHAN_MSG      = 3;   // Message canal (broadcast)
const CMD_GET_CONTACTS       = 4;   // Demander la liste des contacts
const CMD_SET_TIME           = 6;   // Sync horloge après SelfInfo
const CMD_SEND_SELF_ADV      = 7;   // S'annoncer sur le mesh
const CMD_SET_ADVERT_NAME    = 8;   // Changer le nom du device
const CMD_ADD_UPDATE_CONTACT = 9;   // Ajouter / mettre à jour un contact
const CMD_SYNC_NEXT_MSG      = 10;  // Récupérer le message suivant en file
const CMD_SET_RADIO_PARAMS   = 11;  // Paramètres radio LoRa (freq/BW/SF/CR)
const CMD_SET_TX_POWER       = 12;  // Puissance TX (dBm)
const CMD_RESET_PATH         = 13;  // Réinitialiser la route vers un contact
const CMD_SET_ADVERT_LATLON  = 14;  // Définir position GPS d'annonce
const CMD_REMOVE_CONTACT     = 15;  // Supprimer un contact
const CMD_EXPORT_CONTACT     = 17;  // Exporter un contact (binaire)
const CMD_IMPORT_CONTACT     = 18;  // Importer un contact (binaire)
const CMD_REBOOT             = 19;  // Redémarrer le device
const CMD_GET_BATTERY        = 20;  // Batterie / stockage
const CMD_DEVICE_QUERY       = 22;  // Premier handshake (version protocole)
const CMD_SEND_RAW           = 25;  // Raw bytes LoRa (BitMesh custom firmware)
const CMD_SEND_LOGIN         = 26;  // Connexion room server (mot de passe)
const CMD_SEND_STATUS_REQ    = 27;  // Demander le statut d'un contact
const CMD_SEND_BINARY_REQ    = 50;  // Requête binaire (voisins, télémétrie)
const CMD_SET_FLOOD_SCOPE    = 54;  // Définir la portée flood (hops max)
const CMD_GET_STATS          = 56;  // Statistiques device (core/radio/paquets)
const CMD_GET_CHANNEL        = 31;  // Lire config canal N
const CMD_SET_CHANNEL        = 32;  // Écrire config canal N
const CMD_SEND_CHANNEL_DATA  = 62;  // Envoyer des données binaires sur un canal (v1.15.0)

// ── Response / push codes (Device → App) ──────────────────────────────
const RESP_OK               = 0;
const RESP_ERR              = 1;
const RESP_CONTACTS_START   = 2;   // Début liste contacts
const RESP_CONTACT          = 3;   // Un contact
const RESP_END_CONTACTS     = 4;   // Fin liste contacts
const RESP_SELF_INFO        = 5;   // Pubkey, params radio, nom
const RESP_SENT             = 6;   // Message accepté par firmware
const RESP_DIRECT_MSG_OLD   = 7;   // DM v2 — ignoré (V3 = 0x10)
const RESP_CHANNEL_MSG_OLD  = 8;   // Canal v2 — ignoré (V3 = 0x11)
const RESP_CURR_TIME        = 9;   // Heure courante device
const RESP_NO_MORE_MSGS     = 10;  // File vide
const RESP_EXPORT_CONTACT   = 11;  // Contact exporté (binaire)
const RESP_BATT_STORAGE     = 12;  // Batterie (uint16 LE, millivolts) + storage
const RESP_DEVICE_INFO      = 13;  // Firmware / modèle
const RESP_DISABLED         = 15;  // Commande désactivée sur ce device
const RESP_DIRECT_MSG_V3    = 0x10; // PACKET_CONTACT_MSG_RECV_V3
const RESP_CHANNEL_MSG_V3   = 0x11; // PACKET_CHANNEL_MSG_RECV_V3
const RESP_CHANNEL_INFO     = 18;  // Info canal N
const RESP_CUSTOM_VARS      = 21;  // Variables custom
const RESP_STATS            = 24;  // Statistiques device (core/radio/packets)
const RESP_AUTOADD_CONFIG   = 25;  // RESP_CODE_AUTOADD_CONFIG (firmware v1.13+) — anciennement mal nommé "RADIO_SETTINGS"
const RESP_ALLOWED_REPEAT_FREQ = 26; // v1.15 — fréquences répéteur autorisées
const RESP_CHANNEL_DATA_RECV = 27; // Données binaires reçues sur un canal (v1.15.0)
const RESP_DEFAULT_FLOOD_SCOPE = 28; // v1.15 — scope flood par défaut
const PUSH_ADVERT           = 0x80; // Advertisement nœud reçu
const PUSH_PATH_UPDATED     = 0x81; // Route mise à jour vers un contact
const PUSH_SEND_CONFIRMED   = 0x82; // Livraison LoRa confirmée
const PUSH_MSG_WAITING      = 0x83; // Message en file → appeler syncNextMessage()
const PUSH_RAW_DATA         = 0x84; // Données LoRa brutes (BitMesh custom)
const PUSH_LOGIN_SUCCESS    = 0x85; // Connexion room server réussie
const PUSH_LOGIN_FAIL       = 0x86; // Connexion room server échouée
const PUSH_STATUS_RESPONSE  = 0x87; // Statut d'un contact (réponse ping)
const PUSH_TRACE_DATA       = 0x89; // Données trace path
const PUSH_NEW_ADVERT       = 0x8A; // Nouveau nœud découvert
const PUSH_BINARY_RESPONSE  = 0x8C; // Réponse binaire (voisins, télémétrie)
const PUSH_PATH_DISCOVERY_RESPONSE = 0x8D; // Réponse path discovery (firmware v1.13+)
const PUSH_CONTROL_DATA     = 0x8E; // Données de contrôle (v8+ firmware, v1.15)
const PUSH_CONTACT_DELETED  = 0x8F; // Contact supprimé par le firmware (auto-add overflow, v1.15)
const PUSH_CONTACTS_FULL    = 0x90; // Stockage contacts plein (v1.15)

// Types de requêtes binaires (CMD_SEND_BINARY_REQ)
const BINARY_REQ_NEIGHBOURS = 0x06;

// app_target_ver envoyé dans CMD_DEVICE_QUERY (cmd_frame[1]).
// Le firmware MeshCore utilise « app_target_ver >= 3 » pour décider d'envoyer
// les messages au format V3 (RESP_DIRECT_MSG_V3 = 0x10 / RESP_CHANNEL_MSG_V3 = 0x11)
// qui incluent le SNR de la radio. Avec une valeur < 3, on bascule sur les codes
// legacy (7 / 8) qui n'ont pas de SNR. MeshPay implémente les deux parsers, mais
// les V3 sont préférés car ils remontent les métadonnées radio à l'UI.
// (meshcore.js utilise 1 mais ne parse pas les V3 — divergence volontaire.)
const APP_PROTOCOL_VERSION = 3;
const RAW_PUSH_HEADER_SIZE = 3;   // [snr:int8][rssi:int8][reserved:uint8]
const BLE_MAX_WRITE        = 169; // MTU 172 − 3 ATT overhead

// Canal public par défaut (canal 0).
// Clé officielle MeshCore public channel (companion_protocol.md) : 8b3387e9c5cdea6ac9e5edbaa115cd72
// IMPORTANT : NOT all-zeros — using zeros corrupts the T-Beam channel config and breaks LoRa decryption.
const DEFAULT_CHANNEL_NAME   = 'public';
const DEFAULT_CHANNEL_SECRET = new Uint8Array([
  0x8b, 0x33, 0x87, 0xe9, 0xc5, 0xcd, 0xea, 0x6a,
  0xc9, 0xe5, 0xed, 0xba, 0xa1, 0x15, 0xcd, 0x72,
]);

// ── Types publics ──────────────────────────────────────────────────────

export interface BleGatewayDevice {
  id: string;
  name: string;
  rssi: number;
  type?: 'gateway' | 'companion';
}

export interface BleGatewayState {
  connected: boolean;
  device: BleGatewayDevice | null;
  scanning: boolean;
  error: string | null;
}

export interface BleDeviceInfo {
  name: string;
  publicKey: string;   // hex 64 chars (32 bytes)
  txPower: number;     // dBm
  maxTxPower: number;  // dBm max supporté
  radioFreqHz: number; // Hz
  radioBwHz: number;   // Hz
  radioSf: number;
  radioCr: number;
  advLat: number;
  advLon: number;
}

export interface MeshCoreStats {
  type: 'core' | 'radio' | 'packets';
  raw: Record<string, number>;
}

export interface MeshCoreNeighbour {
  pubkeyPrefix: string; // 12 hex chars
  name: string;
  rssi: number;
  snr: number;
  lastHeard: number;    // unix timestamp
  txPower?: number;
}

export interface MeshCoreStatusResponse {
  pubkeyPrefix: string;
  batteryVoltage?: number;
  text?: string;
  rawPayload?: Uint8Array;
}

export interface MeshCoreContact {
  publicKey: Uint8Array;
  pubkeyHex: string;
  pubkeyPrefix: string; // 12 hex chars = 6 bytes
  name: string;
  lastSeen: number;     // unix timestamp
  lat?: number;
  lng?: number;
}

export interface MeshCoreIncomingMsg {
  /** 'announce' est émis pour les advert/beacon LoRa (pas un vrai message texte) */
  type: 'direct' | 'channel' | 'announce';
  channelIdx?: number;
  senderPubkeyPrefix: string; // 12 hex chars, vide pour les messages canal
  pathLen?: number;
  txtType?: number;
  timestamp?: number;
  text?: string;
  snr?: number;
  /** Identifiant optionnel fourni par le firmware MeshCore pour dedup/ACK */
  msgId?: string;
}

export interface ChannelConfig {
  index: number;
  name: string;
  secret: Uint8Array;
  configured: boolean;
}

type MessageHandler   = (packet: MeshCorePacket) => void;
type BleSubscription  = { remove: () => void };

// ── BleGatewayClient ──────────────────────────────────────────────────

export class BleGatewayClient {
  private connectedId: string | null = null;
  private isConnecting = false; // Guard : empêche scan + connect simultanés
  private messageHandler: MessageHandler | null = null;
  private deviceInfo: BleDeviceInfo | null = null;
  private listeners: BleSubscription[] = [];
  private emitter: NativeEventEmitter;

  // Callbacks protocole natif MeshCore Companion
  private deviceInfoCallback:        ((info: BleDeviceInfo) => void) | null = null;
  private incomingMessageCallback:   ((msg: MeshCoreIncomingMsg) => void) | null = null;
  private contactDiscoveredCallback: ((contact: MeshCoreContact) => void) | null = null;
  private contactsCallback:          ((contacts: MeshCoreContact[]) => void) | null = null;
  private sendConfirmedCallback:     ((localMsgId: string | null, ackCode: number, roundTripMs: number) => void) | null = null;
  private messageAcceptedCallback:   ((localMsgId: string, expectedAck: number, estTimeoutMs: number, isFlood: boolean) => void) | null = null;
  private disconnectCallback:        (() => void) | null = null;
  private batteryCallback:           ((volts: number) => void) | null = null;
  private statsCallback:             ((stats: MeshCoreStats) => void) | null = null;
  private neighboursCallback:        ((neighbours: MeshCoreNeighbour[]) => void) | null = null;
  private statusResponseCallback:    ((status: MeshCoreStatusResponse) => void) | null = null;
  private pathUpdatedCallback:       ((pubkeyPrefix: string) => void) | null = null;
  private loginResultCallback:       ((success: boolean) => void) | null = null;
  private exportContactCallback:     ((data: Uint8Array) => void) | null = null;

  // Gestion contacts
  private pendingContacts: MeshCoreContact[] = [];

  // ── ACK tracking (firmware native PUSH_SEND_CONFIRMED) ─────────────
  // Quand l'app envoie un CMD_SEND_TXT_MSG, on pousse le localMsgId dans une
  // FIFO. Le firmware répond avec RESP_SENT contenant `expected_ack` (uint32)
  // — on le pop puis on map expectedAck → localMsgId. Plus tard, le firmware
  // émet PUSH_SEND_CONFIRMED avec le même hash : on retrouve le localMsgId,
  // on le passe à sendConfirmedCallback (qui marque le message « delivered »).
  private pendingMsgIdQueue: string[] = [];           // FIFO en attente de RESP_SENT
  private expectedAckToMsgId = new Map<number, string>(); // expected_ack → localMsgId
  private readonly ACK_MAP_MAX = 200;                 // garde-fou anti-fuite mémoire

  // Buffer de paquets reçus avant l'enregistrement du messageHandler
  // Évite de perdre des messages si syncNextMessage() est appelé avant onMessage()
  private pendingPackets: MeshCorePacket[] = [];
  private readonly PENDING_PACKETS_MAX = 50; // limite anti-fuite mémoire

  // MTU négocié avec le device (utilisé pour le chunking BLE)
  private negotiatedMtu = BLE_MAX_WRITE;

  // Gestion canaux
  private channelConfigs: Map<number, ChannelConfig> = new Map();

  // Handshake SelfInfo avec retry
  private awaitingSelfInfo = false;
  private selfInfoRetryTimer: ReturnType<typeof setInterval> | null = null;
  private selfInfoResolvers: Array<() => void> = [];

  // Write characteristics capability
  private canWriteWithoutResponse = false;

  constructor() {
    this.emitter = new NativeEventEmitter(NativeModules.BleManager);
  }

  // ── Initialisation ────────────────────────────────────────────────

  async initialize(): Promise<void> {
    await BleManager.start({ showAlert: false });
    console.log('[BleGateway] BleManager démarré');
  }

  // ── Scan ──────────────────────────────────────────────────────────

  /**
   * Scan BLE actif — trois phases :
   *
   * Phase 0 : devices déjà bondés (directed advertising, invisible au scan normal)
   * Phase 1 (6s) : scan filtré sur Nordic UART UUID — hardware-filter Android 13+, pas de throttling
   * Phase 2 (4s) : fallback sans filtre (firmware custom sans NUS dans l'ADV primaire)
   */
  async scanForGateways(
    onDeviceFound: (device: BleGatewayDevice) => void,
    timeoutMs = 10000
  ): Promise<void> {
    // Guard : pas de scan si une connexion est en cours (conflit BLE natif Android)
    if (this.isConnecting) {
      console.warn('[BleGateway] Scan bloqué : connexion BLE en cours');
      throw new Error('Connexion BLE en cours, réessayez dans quelques secondes');
    }

    console.log('[BleGateway] Scan BLE actif...');
    const seen = new Set<string>();

    const reportDevice = (peripheral: {
      id: string;
      name?: string;
      rssi?: number;
      advertising?: { localName?: string };
    }) => {
      const name: string =
        peripheral.name || peripheral.advertising?.localName || '';

      if (seen.has(peripheral.id) && !name) return;
      seen.add(peripheral.id);

      const displayName = name || `BLE (${peripheral.id.slice(0, 8)})`;
      const isMeshCore =
        displayName.toLowerCase().includes('meshcore') ||
        displayName.toLowerCase().includes('whisper') ||
        displayName.toLowerCase().includes('bitmesh') ||
        displayName.toLowerCase().includes('lora');

      console.log(`[BleGateway] Trouvé: "${displayName}" RSSI ${peripheral.rssi ?? '?'}`);
      onDeviceFound({
        id: peripheral.id,
        name: displayName,
        rssi: peripheral.rssi || -100,
        type: isMeshCore ? 'companion' : 'gateway',
      });
    };

    // ── Phase 0 : devices bondés (directed advertising → invisible au scan normal) ──
    try {
      const bonded: any[] = await BleManager.getBondedPeripherals();
      console.log(`[BleGateway] ${bonded.length} device(s) bondé(s)`);
      for (const p of bonded) reportDevice(p);
    } catch (e) {
      console.log('[BleGateway] getBondedPeripherals non supporté:', e);
    }

    const listener = this.emitter.addListener('BleManagerDiscoverPeripheral', reportDevice);

    // ── Scan universel sans filtre UUID ──
    // Le filtre serviceUUIDs sur Android peut entrer en conflit avec une connexion active
    // ou ne retourner aucun résultat selon le firmware. Un scan sans filtre est plus fiable.
    try {
      await BleManager.stopScan().catch(() => { /* cleanup: ignore */ });
      await BleManager.scan({ serviceUUIDs: [], seconds: timeoutMs / 1000 });
      await new Promise((res) => setTimeout(res, timeoutMs));
      await BleManager.stopScan();
    } catch (e) {
      console.log('[BleGateway] Scan erreur:', e);
    }

    listener.remove();
    console.log(`[BleGateway] Scan terminé — ${seen.size} device(s)`);
  }

  stopScan(): void {
    BleManager.stopScan();
  }

  // ── Connect ──────────────────────────────────────────────────────

  async connect(deviceId: string): Promise<void> {
    this.isConnecting = true;
    this.listeners.forEach((l) => l.remove());
    this.listeners = [];
    this.clearSelfInfoRetry();
    this.selfInfoResolvers = [];
    this.awaitingSelfInfo = false;
    this.canWriteWithoutResponse = false;
    this.channelConfigs.clear();
    this.negotiatedMtu = BLE_MAX_WRITE;

    console.log(`[BleGateway] Connexion à ${deviceId}...`);
    
    // Écouteurs temporaires à nettoyer en cas d'erreur
    let notifListener: BleSubscription | null = null;
    let discListener: BleSubscription | null = null;
    
    try {

    // ── 1. Connexion BLE ──
    await BleManager.connect(deviceId);
    this.connectedId = deviceId;
    console.log('[BleGateway] Connecté');

    // ── 2. MTU 185 (meshcore-open standard) ──
    try {
      const mtu = await BleManager.requestMTU(deviceId, 185);
      this.negotiatedMtu = Math.min(mtu - 3, BLE_MAX_WRITE); // ATT overhead = 3 bytes
      console.log(`[BleGateway] MTU négocié : ${mtu}, utilisable : ${this.negotiatedMtu}`);
    } catch {
      this.negotiatedMtu = BLE_MAX_WRITE;
      console.log('[BleGateway] MTU request ignoré, utilisation défaut:', this.negotiatedMtu);
    }

    // ── 3. Découverte services — vérifier NUS présent (deux formats) ──
    const services = await BleManager.retrieveServices(deviceId) as any;
    const hasUart =
      services.serviceUUIDs?.some((u: string) => u.toLowerCase() === SERVICE_UUID.toLowerCase()) ||
      services.services?.some((s: any) => {
        const uuid = typeof s === 'string' ? s : s?.uuid;
        return uuid?.toLowerCase() === SERVICE_UUID.toLowerCase();
      });

    if (!hasUart) {
      await BleManager.disconnect(deviceId);
      this.connectedId = null;
      throw new Error('Service Nordic UART non trouvé. Firmware MeshCore Companion BLE requis.');
    }
    console.log('[BleGateway] Nordic UART Service trouvé');

    // Détecter WriteWithoutResponse sur la caractéristique TX (App → Device)
    const allChars: any[] = services.characteristics || [];
    for (const char of allChars) {
      const uuid = (char.characteristic || char.uuid || '').toLowerCase();
      if (uuid === TX_UUID.toLowerCase() || uuid.startsWith('6e400002')) {
        this.canWriteWithoutResponse = !!char.properties?.WriteWithoutResponse;
        break;
      }
    }
    console.log(`[BleGateway] WriteWithoutResponse: ${this.canWriteWithoutResponse}`);

    // ── 4. Bonding EXPLICITE (dialogue PIN Android) ──
    await this.createBondExplicit(deviceId, 60000);

    // ── 4b. Re-découverte APRÈS bond ─────────────────────────────────
    // Bug Android classique : createBond invalide le cache de services GATT ;
    // les handles découverts avant le bond peuvent être obsolètes. Sur Xiaomi
    // HyperOS (Android 16) on observe que startNotification() « réussit »
    // mais les notifications RX ne reviennent jamais — le CCCD est écrit sur
    // un handle périmé. Rediscovery post-bond est obligatoire.
    try {
      await BleManager.retrieveServices(deviceId);
      if (__DEV__) console.log('[BleGateway] Services re-discovered after bond');
    } catch (e) {
      console.warn('[BleGateway] Post-bond rediscovery failed (continuing):', e);
    }

    // ── 5a. Listener AVANT startNotification ──
    // Si on l'attachait après, certaines piles BLE OEM livrent une première
    // notification entre les deux lignes et on la perd.
    // En release on log quand même les premières trames reçues (sans __DEV__)
    // pour diagnostiquer les cas "device connecté mais app muette" — comme
    // observé avec MeshCore v1.13 sur Xiaomi Redmi / Android 16.
    let framesReceivedCount = 0;
    notifListener = this.emitter.addListener(
      'BleManagerDidUpdateValueForCharacteristic',
      (data: any) => {
        if (data.peripheral !== deviceId) return;
        const rawChar = data.characteristic || '';
        const charLower = rawChar.toLowerCase();
        // Log les 2 premières trames reçues pour prouver que les notifications
        // passent bien. Filtre ensuite par UUID RX (6e400003).
        if (framesReceivedCount < 2) {
          framesReceivedCount++;
          console.log(`[BleGateway] RX event #${framesReceivedCount} char=${rawChar} bytes=${data.value?.length ?? 0}`);
        }
        if (!charLower.startsWith('6e400003')) return;
        this.handleFrame(new Uint8Array(data.value));
      }
    );
    this.listeners.push(notifListener);
    notifListener = null; // Transféré au tableau listeners

    // ── 5b. Activer notifications RX (Device → App) ──
    // ATTENTION : ne PAS utiliser startNotificationWithBuffer sur ce projet.
    // MeshCore envoie des frames de taille variable (SelfInfo ~50 octets,
    // ChannelMsg ~30 octets…). startNotificationWithBuffer(N) accumule les
    // bytes dans un buffer côté natif et ne bridge à JS que quand il atteint
    // exactement N octets — sinon il retourne silencieusement. Résultat :
    // les frames courtes ne sont JAMAIS remontées, le handshake expire.
    // (Piège observé 2026-04-20 sur Redmi/HyperOS.)
    let notifySet = false;
    for (let attempt = 0; attempt < 3 && !notifySet; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
        await BleManager.startNotification(deviceId, SERVICE_UUID, RX_UUID);
        console.log(`[BleGateway] Notifications activées (tentative ${attempt + 1})`);
        notifySet = true;
        await new Promise((r) => setTimeout(r, 300));
      } catch (e) {
        console.log(`[BleGateway] startNotification ${attempt + 1}/3 échoué:`, e);
        if (attempt === 2) throw e;
      }
    }

    // ── 5c. Belt-and-suspenders : écrire le CCCD 0x2902 nous-mêmes ──
    // Observé sur Redmi/HyperOS/Android 16 : startNotificationWithBuffer
    // résout "success" mais BluetoothGatt ne log aucun writeDescriptor(),
    // donc le péripherique ne reçoit jamais le bit NOTIFY. Cet appel direct
    // à writeDescriptor passe par un code-path différent dans ble-manager
    // (BleManager.writeDescriptor → Peripheral.writeDescriptor) qui sur
    // certains OEM rétablit l'écriture quand startNotification* la perd.
    // [0x01, 0x00] = ENABLE_NOTIFICATION_VALUE (spec Bluetooth Core v4.0+).
    if (Platform.OS === 'android') {
      try {
        const CCCD_UUID = '00002902-0000-1000-8000-00805f9b34fb';
        await (BleManager as any).writeDescriptor(
          deviceId, SERVICE_UUID, RX_UUID, CCCD_UUID, [0x01, 0x00]
        );
        console.log('[BleGateway] CCCD 0x2902 écrit manuellement (0x0100)');
      } catch (e) {
        console.log('[BleGateway] CCCD manual write échoué (non-fatal):', e);
      }
    }

    // Écouter déconnexion
    discListener = this.emitter.addListener(
      'BleManagerDisconnectPeripheral',
      (data: any) => {
        if (data.peripheral !== deviceId) return;
        console.log('[BleGateway] Device déconnecté');
        this.connectedId = null;
        this.clearSelfInfoRetry();
        this.disconnectCallback?.();
      }
    );
    this.listeners.push(discListener);
    discListener = null; // Transféré au tableau listeners

    // ── 6. Handshake MeshCore ──
    // Ordre officiel (companion_protocol.md §5) : APP_START **puis** DEVICE_QUERY.
    // APP_START déclenche la réponse SelfInfo qu'on attend. DEVICE_QUERY sert
    // ensuite à négocier `app_target_ver` côté firmware (utilisé par V3 msgs).
    this.awaitingSelfInfo = true;
    await this.sendAppStart();
    this.scheduleSelfInfoRetry();

    // DEVICE_QUERY peut partir en parallèle — sa réponse (DEVICE_INFO code 13)
    // est indépendante du SelfInfo qu'on attend.
    this.sendFrame(CMD_DEVICE_QUERY, new Uint8Array([APP_PROTOCOL_VERSION]))
      .then(() => console.log('[BleGateway] DeviceQuery envoyé'))
      .catch((e) => console.warn('[BleGateway] DeviceQuery échoué:', e));

    // Attendre SelfInfo (3s) + une relance manuelle, puis arrêter explicitement
    // la boucle de retry (sinon scheduleSelfInfoRetry continue jusqu'au cap).
    const gotSelfInfo = await this.waitForSelfInfo(3000);
    if (!gotSelfInfo) {
      console.log('[BleGateway] SelfInfo non reçu après 3s — relance manuelle...');
      await this.sendAppStart();
      await this.sendFrame(CMD_DEVICE_QUERY, new Uint8Array([APP_PROTOCOL_VERSION])).catch(() => {});
      const gotRetry = await this.waitForSelfInfo(4000);
      if (!gotRetry) {
        console.warn('[BleGateway] SelfInfo toujours absent après relance — firmware incompatible ?');
        this.awaitingSelfInfo = false;
        this.clearSelfInfoRetry();
        throw new Error('MeshCore handshake failed: SelfInfo not received (firmware unresponsive)');
      }
    }
    // Handshake réussi — arrêter la boucle interval de retry en filet de sécurité.
    this.clearSelfInfoRetry();

    // ── 7. Post-connexion ──
    // Configurer canal 0 (public) pour recevoir les broadcasts
    await this.configureDefaultChannels();

    // Récupérer les canaux configurés sur le device
    this.getChannels(4).catch((e) => console.warn('[BleGateway] getChannels:', e));

    // Récupérer les contacts (nœuds connus)
    this.getContacts().catch((e) => console.warn('[BleGateway] getContacts:', e));

    // Récupérer les messages mis en file pendant la déconnexion (doc : CMD_SYNC_NEXT_MESSAGE requis à l'init)
    this.syncNextMessage().catch((e) => console.warn('[BleGateway] syncNextMessage initial:', e));

    // S'annoncer sur le mesh
    this.sendSelfAdvert(1).catch((e) => console.warn('[BleGateway] sendSelfAdvert:', e));

    console.log('[BleGateway] Handshake terminé');
    } catch (error) {
      // Nettoyer les listeners temporaires en cas d'erreur
      notifListener?.remove();
      discListener?.remove();
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  // ── Bonding explicite ────────────────────────────────────────────

  private async createBondExplicit(deviceId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const done = (err?: Error) => {
        if (resolved) return;
        resolved = true;
        bondListener.remove();
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      const timer = setTimeout(() => {
        console.warn('[BleGateway] Bonding timeout — tentative de continuer...');
        done();
      }, timeoutMs);

      const bondListener = this.emitter.addListener(
        'BleManagerBondingComplete',
        (data: any) => {
          if (data.peripheral !== deviceId) return;
          if (data.status === 'success') {
            console.log('[BleGateway] Bonding réussi');
            done();
          } else {
            done(new Error(`Bonding échoué : ${data.status}. PIN défaut : 123456.`));
          }
        }
      );

      console.log('[BleGateway] createBond() — entrez le PIN dans le dialogue Android...');
      BleManager.createBond(deviceId)
        .then(() => {
          // Peut signifier "déjà bondé" — attendre BleManagerBondingComplete, sinon timeout 3s
          setTimeout(() => done(), 3000);
        })
        .catch((err: any) => {
          const msg = String(err?.message ?? err ?? '').toLowerCase();
          if (msg.includes('already') || msg.includes('bonded') || msg.includes('11')) {
            console.log('[BleGateway] Device déjà bondé');
            done();
          } else {
            done(new Error(msg));
          }
        });
    });
  }

  // ── Disconnect ──────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    this.clearSelfInfoRetry();
    this.selfInfoResolvers = [];
    this.awaitingSelfInfo = false;
    this.listeners.forEach((l) => l.remove());
    this.listeners = [];
    this.channelConfigs.clear();
    // Purger le buffer de paquets au déconnexion (évite replay de messages obsolètes)
    if (this.pendingPackets.length > 0) {
      console.warn(`[BleGateway] Déconnexion : purge de ${this.pendingPackets.length} paquet(s) bufferisé(s)`);
      this.pendingPackets = [];
    }
    if (this.connectedId) {
      console.log('[BleGateway] Déconnexion...');
      await BleManager.disconnect(this.connectedId).catch(() => { /* cleanup: ignore */ });
      this.connectedId = null;
    }
  }

  // ── AppStart / SelfInfo retry ────────────────────────────────────

  private async sendAppStart(): Promise<void> {
    // Source de vérité : MyMesh.cpp ligne 933-937 (firmware v1.13) :
    //   } else if (cmd_frame[0] == CMD_APP_START && len >= 8) {
    //     //  cmd_frame[1..7]  reserved future
    //     char *app_name = (char *)&cmd_frame[8];
    // → Layout : [cmd:1][reserved:7][app_name:UTF-8][null-padding si besoin]
    // Firmware exige len >= 8. app_name commence obligatoirement à cmd_frame[8].
    // Donc payload (sans le cmd byte) doit avoir 7 bytes réservés + nom à payload[7+].
    const appNameBytes = new TextEncoder().encode('MeshPay\0');
    const payload = new Uint8Array(7 + appNameBytes.length);
    // payload[0..6] = 7 bytes réservés (tous zéro — firmware les ignore complètement)
    payload.set(appNameBytes, 7);
    await this.sendFrame(CMD_APP_START, payload);
    console.log('[BleGateway] AppStart envoyé (name=MeshPay, len=' + (payload.length + 1) + 'B)');
  }

  // Cap le retry SelfInfo : sinon un firmware MeshCore silencieux
  // (version mismatch, device en mode autre, corruption) provoque un flood
  // infini de re-envois AppStart toutes les 3.5s. Observé live : 40+ retries
  // en < 3 min, drainant la batterie et spammant le log.
  private static readonly SELF_INFO_MAX_RETRIES = 3;
  private selfInfoRetryCount = 0;

  private scheduleSelfInfoRetry(): void {
    this.clearSelfInfoRetry();
    this.selfInfoRetryCount = 0;
    this.selfInfoRetryTimer = setInterval(async () => {
      if (!this.connectedId || !this.awaitingSelfInfo) {
        this.clearSelfInfoRetry();
        return;
      }
      if (this.selfInfoRetryCount >= BleGatewayClient.SELF_INFO_MAX_RETRIES) {
        console.warn(
          `[BleGateway] SelfInfo: ${BleGatewayClient.SELF_INFO_MAX_RETRIES} retries épuisés — handshake abandonné`,
        );
        this.awaitingSelfInfo = false;
        this.clearSelfInfoRetry();
        // Déconnecter pour que l'UI propose un rescan/retry manuel au lieu de
        // laisser l'utilisateur devant une connexion fantôme.
        if (this.connectedId) {
          BleManager.disconnect(this.connectedId).catch(() => { /* cleanup: ignore */ });
          this.connectedId = null;
          this.disconnectCallback?.();
        }
        return;
      }
      this.selfInfoRetryCount++;
      if (__DEV__) {
        console.log(
          `[BleGateway] SelfInfo retry ${this.selfInfoRetryCount}/${BleGatewayClient.SELF_INFO_MAX_RETRIES} — re-envoi AppStart...`,
        );
      }
      this.sendAppStart().catch((e) =>
        console.warn('[BleGateway] sendAppStart retry failed:', e),
      );
    }, 3500);
  }

  private clearSelfInfoRetry(): void {
    if (this.selfInfoRetryTimer !== null) {
      clearInterval(this.selfInfoRetryTimer);
      this.selfInfoRetryTimer = null;
    }
    this.selfInfoRetryCount = 0;
  }

  private waitForSelfInfo(timeoutMs: number): Promise<boolean> {
    if (!this.awaitingSelfInfo) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const resolver = () => {
        if (!done) { done = true; clearTimeout(timer); resolve(true); }
      };
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          this.selfInfoResolvers = this.selfInfoResolvers.filter((r) => r !== resolver);
          resolve(false);
        }
      }, timeoutMs);
      this.selfInfoResolvers.push(resolver);
    });
  }

  // ── Configuration des canaux ──────────────────────────────────────

  private async configureDefaultChannels(): Promise<void> {
    console.log('[BleGateway] Configuration canal 0 (public)...');
    try {
      await this.setChannel(0, DEFAULT_CHANNEL_NAME, DEFAULT_CHANNEL_SECRET);
      console.log('[BleGateway] Canal 0 configuré');
    } catch (err) {
      console.warn('[BleGateway] Configuration canal 0 échouée:', err);
    }
  }

  // ── Protocole natif MeshCore Companion ───────────────────────────

  /**
   * Envoie un paquet BitMesh encodé via CMD_SEND_RAW (0x19).
   * FIRMWARE CUSTOM REQUIS — incompatible avec firmware MeshCore standard.
   */
  async sendPacket(packet: MeshCorePacket): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté à un device MeshCore');
    const encoded = encodeMeshCorePacket(packet);
    await this.sendRawPacket(encoded);
  }

  /**
   * Envoie des données brutes déjà encodées via CMD_SEND_RAW (0x19).
   * Utilisé par les services de retry qui stockent les paquets en binaire.
   */
  async sendRawPacket(encoded: Uint8Array): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté à un device MeshCore');
    const payload = new Uint8Array(1 + encoded.length);
    payload[0] = 0x00; // path_length = 0 (broadcast)
    payload.set(encoded, 1);
    await this.sendFrame(CMD_SEND_RAW, payload);
  }

  /**
   * Envoie un DM via CMD_SEND_TXT_MSG (0x02) — firmware standard v1.13/v1.15.
   * Format : [txt_type:1][attempt:1][timestamp:4LE][pub_key_prefix:6][text...]
   * Le destinataire doit être dans les contacts du device (lookupContactByPubKey).
   *
   * @param localMsgId  Identifiant local du message (DBMessage.id). Quand fourni,
   *                    le firmware ACK (PUSH_SEND_CONFIRMED) sera mappé vers ce
   *                    msgId via sendConfirmedCallback — l'app peut alors marquer
   *                    le message « delivered » dans SQLite.
   */
  async sendDirectMessage(pubkeyHex: string, text: string, attempt = 0, localMsgId?: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté à un device MeshCore');

    const hexClean = this.normalizePubkeyHex(pubkeyHex);
    const pubkeyBytes = new Uint8Array(hexClean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    const textBytes   = new TextEncoder().encode(text);
    const ts          = Math.floor(Date.now() / 1000);
    const tsBuf       = new Uint8Array(4);
    new DataView(tsBuf.buffer).setUint32(0, ts, true);

    const payload = new Uint8Array(1 + 1 + 4 + 6 + textBytes.length);
    let i = 0;
    payload[i++] = 0;               // txt_type = TXT_TYPE_PLAIN
    payload[i++] = attempt & 0xFF;
    payload.set(tsBuf, i);      i += 4;
    payload.set(pubkeyBytes.slice(0, 6), i); i += 6;
    payload.set(textBytes, i);

    console.log(`[BleGateway] sendDirectMessage → prefix=${hexClean.slice(0, 12)} (${text.length}B)`);
    if (localMsgId) this.pendingMsgIdQueue.push(localMsgId);
    try {
      await this.sendFrame(CMD_SEND_TXT_MSG, payload);
    } catch (err) {
      // Echec d'écriture BLE : retire l'id de la file (jamais d'ACK firmware attendu).
      if (localMsgId) {
        const idx = this.pendingMsgIdQueue.lastIndexOf(localMsgId);
        if (idx >= 0) this.pendingMsgIdQueue.splice(idx, 1);
      }
      throw err;
    }
  }

  /**
   * Envoie un message canal via CMD_SEND_CHAN_MSG (0x03) — firmware v1.13/v1.15.
   * Format officiel : [txt_type:1][channel_idx:1][timestamp:4LE][text...]
   * Source : meshcore.js library sendCommandSendChannelTxtMsg
   *
   * NOTE : les messages canal n'ont PAS d'expected_ack (broadcast) — le firmware
   * répond bien RESP_SENT mais expected_ack=0 et aucun PUSH_SEND_CONFIRMED ne
   * suit. Le localMsgId est tout de même tracé pour le RESP_SENT (transition
   * « sending » → « sent »).
   */
  async sendChannelMessage(channelIdx: number, text: string, localMsgId?: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté à un device MeshCore');

    // Vérifier que le canal est configuré (auto-configure si canal 0)
    const channelConfig = this.channelConfigs.get(channelIdx);
    if (!channelConfig?.configured) {
      console.warn(`[BleGateway] Canal ${channelIdx} non configuré, configuration auto...`);
      if (channelIdx === 0) {
        await this.configureDefaultChannels();
      } else {
        throw new Error(`Canal ${channelIdx} non configuré. Appelez setChannel() d'abord.`);
      }
    }

    const textBytes = new TextEncoder().encode(text);
    if (textBytes.length > 150) throw new Error(`Message trop long: ${textBytes.length}B (max 150)`);

    const ts    = Math.floor(Date.now() / 1000);
    const tsBuf = new Uint8Array(4);
    new DataView(tsBuf.buffer).setUint32(0, ts, true);

    // Format officiel : [txt_type:1][channel_idx:1][timestamp:4LE][text...]
    const payload = new Uint8Array(1 + 1 + 4 + textBytes.length);
    let i = 0;
    payload[i++] = 0;               // txt_type = TXT_TYPE_PLAIN
    payload[i++] = channelIdx & 0xFF;
    payload.set(tsBuf, i);      i += 4;
    payload.set(textBytes, i);

    console.log(`[BleGateway] sendChannelMessage ch=${channelIdx} (${text.length}B)`);
    if (localMsgId) this.pendingMsgIdQueue.push(localMsgId);
    try {
      await this.sendFrame(CMD_SEND_CHAN_MSG, payload);
    } catch (err) {
      if (localMsgId) {
        const idx = this.pendingMsgIdQueue.lastIndexOf(localMsgId);
        if (idx >= 0) this.pendingMsgIdQueue.splice(idx, 1);
      }
      throw err;
    }
  }

  /**
   * Envoie des données binaires sur un canal (v1.15.0+).
   * Format officiel : [channel_idx:1][path_len:1][path...][data_type:2LE][payload...]
   */
  async sendChannelData(channelIdx: number, dataType: number, payload: Uint8Array, path: Uint8Array = new Uint8Array(0)): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    if (payload.length > 150) throw new Error(`Payload trop long: ${payload.length}B (max 150)`);

    const frame = new Uint8Array(1 + 1 + path.length + 2 + payload.length);
    let i = 0;
    frame[i++] = channelIdx & 0xFF;
    frame[i++] = path.length & 0xFF;
    frame.set(path, i);       i += path.length;
    new DataView(frame.buffer).setUint16(i, dataType, true); i += 2;
    frame.set(payload, i);

    console.log(`[BleGateway] sendChannelData ch=${channelIdx} type=${dataType} (${payload.length}B)`);
    await this.sendFrame(CMD_SEND_CHANNEL_DATA, frame);
  }

  async syncNextMessage(): Promise<void> {
    if (!this.connectedId) return;
    await this.sendFrame(CMD_SYNC_NEXT_MSG, new Uint8Array(0));
  }

  async sendSelfAdvert(type: 0 | 1 = 1): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    await this.sendFrame(CMD_SEND_SELF_ADV, new Uint8Array([type]));
  }

  async getContacts(): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    this.pendingContacts = [];
    await this.sendFrame(CMD_GET_CONTACTS, new Uint8Array(0));
    console.log('[BleGateway] CMD_GET_CONTACTS envoyé');
  }

  async getChannels(maxChannels = 8): Promise<void> {
    if (!this.connectedId) return;
    for (let i = 0; i < maxChannels; i++) {
      if (!this.connectedId) break;
      try {
        await this.sendFrame(CMD_GET_CHANNEL, new Uint8Array([i]));
        await new Promise((r) => setTimeout(r, 400));
      } catch (e) {
        console.warn(`[BleGateway] getChannel[${i}] échoué:`, e);
      }
    }
  }

  /**
   * Configure un canal sur le device.
   * Format CMD_SET_CHANNEL : [idx:1][name:32 null-padded][secret:16] — total 49 bytes
   * Doc officielle MeshCore v1.13 : secret = 16 bytes. 32-byte variant → PACKET_ERROR.
   */
  async setChannel(channelIdx: number, name: string, secret: Uint8Array): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    if (channelIdx < 0 || channelIdx > 7) throw new Error(`Canal invalide: ${channelIdx}`);

    const payload   = new Uint8Array(1 + 32 + 16); // 49 bytes total
    payload[0]      = channelIdx;
    const nameBytes = new TextEncoder().encode(name);
    payload.set(nameBytes.slice(0, Math.min(nameBytes.length, 31)), 1); // null-padded 32B
    payload.set(secret.slice(0, 16), 33);

    console.log(`[BleGateway] setChannel ${channelIdx}: "${name}"`);
    await this.sendFrame(CMD_SET_CHANNEL, payload);

    this.channelConfigs.set(channelIdx, {
      index: channelIdx,
      name,
      secret: secret.slice(0, 16),
      configured: true,
    });
  }

  // ── Commandes device ─────────────────────────────────────────────

  /** Changer le nom d'annonce du device sur le mesh */
  async setAdvertName(name: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const nameBytes = new TextEncoder().encode(name.slice(0, 31) + '\0');
    await this.sendFrame(CMD_SET_ADVERT_NAME, nameBytes);
    console.log(`[BleGateway] SetAdvertName: "${name}"`);
  }

  /** Définir la puissance TX (dBm) */
  async setTxPower(dbm: number): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    await this.sendFrame(CMD_SET_TX_POWER, new Uint8Array([dbm & 0xFF]));
    console.log(`[BleGateway] SetTxPower: ${dbm} dBm`);
  }

  /**
   * Paramètres radio LoRa — [freq:4LE uint32 Hz][bw:4LE uint32 Hz][sf:1][cr:1]
   * cr : 5=CR4/5, 6=CR4/6, 7=CR4/7, 8=CR4/8
   */
  async setRadioParams(freqHz: number, bwHz: number, sf: number, cr: number): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const payload = new Uint8Array(10);
    const view = new DataView(payload.buffer);
    view.setUint32(0, freqHz, true);
    view.setUint32(4, bwHz, true);
    payload[8] = sf & 0xFF;
    payload[9] = cr & 0xFF;
    await this.sendFrame(CMD_SET_RADIO_PARAMS, payload);
    console.log(`[BleGateway] SetRadioParams: ${(freqHz/1e6).toFixed(3)} MHz BW=${bwHz/1000}kHz SF${sf} CR4/${cr}`);
  }

  /** Définir position GPS d'annonce [lat:4LE int32 × 1e6][lon:4LE int32 × 1e6] */
  async setAdvertLatLon(lat: number, lon: number): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    view.setInt32(0, Math.round(lat * 1e6), true);
    view.setInt32(4, Math.round(lon * 1e6), true);
    await this.sendFrame(CMD_SET_ADVERT_LATLON, payload);
    console.log(`[BleGateway] SetAdvertLatLon: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  }

  /** Normalise une clé publique hex (gère les clés compressées secp256k1 66 chars en loggant un warning) */
  private normalizePubkeyHex(pubkeyHex: string): string {
    if (pubkeyHex.length === 66) {
      console.warn('[BleGateway] Clé publique compressée (66 hex) détectée — slice(2) appliqué. ATTENTION: MeshCore attend un hash de 32 bytes (64 hex), pas une clé secp256k1 brute.');
      return pubkeyHex.slice(2);
    }
    if (pubkeyHex.length !== 64) {
      console.warn(`[BleGateway] Clé publique de taille inattendue: ${pubkeyHex.length} hex (attendu: 64)`);
    }
    return pubkeyHex;
  }

  /** Réinitialiser la route vers un contact (pubkey hex 64) */
  async resetPath(pubkeyHex: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const hexClean = this.normalizePubkeyHex(pubkeyHex);
    const pubkeyBytes = new Uint8Array(hexClean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    await this.sendFrame(CMD_RESET_PATH, pubkeyBytes);
    console.log(`[BleGateway] ResetPath: ${hexClean.slice(0, 12)}...`);
  }

  /** Supprimer un contact (pubkey hex 64) */
  async removeContact(pubkeyHex: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const hexClean = this.normalizePubkeyHex(pubkeyHex);
    const pubkeyBytes = new Uint8Array(hexClean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    await this.sendFrame(CMD_REMOVE_CONTACT, pubkeyBytes);
    console.log(`[BleGateway] RemoveContact: ${hexClean.slice(0, 12)}...`);
  }

  /** Exporter un contact (binaire) — réponse via onExportContact */
  async exportContact(pubkeyHex: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const hexClean = this.normalizePubkeyHex(pubkeyHex);
    const pubkeyBytes = new Uint8Array(hexClean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    await this.sendFrame(CMD_EXPORT_CONTACT, pubkeyBytes);
  }

  /** Importer un contact depuis les données exportées */
  async importContact(data: Uint8Array): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    await this.sendFrame(CMD_IMPORT_CONTACT, data);
  }

  /** Demander la tension de batterie — réponse via onBattery */
  async getBattery(): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    await this.sendFrame(CMD_GET_BATTERY, new Uint8Array(0));
  }

  /** Redémarrer le device */
  async reboot(): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    // Le firmware attend la string "reboot" après le cmd (cohérent avec meshcore.js)
    await this.sendFrame(CMD_REBOOT, new TextEncoder().encode('reboot'));
    console.log('[BleGateway] Reboot envoyé');
  }

  /**
   * Définir la région/scope par défaut pour les flood packets (v1.15.0+).
   * La transportKey est dérivée du nom de région via SHA-256 (comme dans meshcore.js).
   * Si aucune région n'est fournie, le scope est désactivé (traffic non-scopé).
   */
  async setFloodScope(regionName: string | null): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    if (!regionName) {
      // Désactiver le scope : envoyer une transportKey vide (32 zéros)
      await this.sendFrame(CMD_SET_FLOOD_SCOPE, new Uint8Array(33)); // [0] + 32 zéros
      console.log('[BleGateway] SetFloodScope: désactivé');
      return;
    }
    const name = regionName.startsWith('#') ? regionName : `#${regionName}`;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name));
    const transportKey = new Uint8Array(hash);
    const payload = new Uint8Array(1 + 32);
    payload[0] = 0; // byte obligatoire (vérifié par firmware v8+)
    payload.set(transportKey, 1);
    await this.sendFrame(CMD_SET_FLOOD_SCOPE, payload);
    console.log(`[BleGateway] SetFloodScope: région="${name}"`);
  }

  /** Statistiques device — type: 0=core, 1=radio, 2=packets. Réponse via onStats */
  async getStats(type: 0 | 1 | 2 = 0): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    await this.sendFrame(CMD_GET_STATS, new Uint8Array([type]));
  }

  /** Liste des voisins directs (1-hop) — réponse via onNeighbours */
  async getNeighbours(): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    await this.sendFrame(CMD_SEND_BINARY_REQ, new Uint8Array([BINARY_REQ_NEIGHBOURS]));
  }

  /** Connexion à un room server via mot de passe — [pubkey:32][password...] */
  async sendLogin(pubkeyHex: string, password: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const hexClean = this.normalizePubkeyHex(pubkeyHex);
    const pubkeyBytes = new Uint8Array(hexClean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    const passBytes = new TextEncoder().encode(password);
    const payload = new Uint8Array(32 + passBytes.length);
    payload.set(pubkeyBytes, 0);
    payload.set(passBytes, 32);
    await this.sendFrame(CMD_SEND_LOGIN, payload);
  }

  /** Ping statut d'un contact — réponse via onStatusResponse */
  async sendStatusReq(pubkeyHex: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const hexClean = this.normalizePubkeyHex(pubkeyHex);
    const pubkeyBytes = new Uint8Array(hexClean.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    await this.sendFrame(CMD_SEND_STATUS_REQ, pubkeyBytes);
  }

  // ── Callbacks publics ────────────────────────────────────────────

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
    // Rejouer les paquets bufferisés reçus avant l'enregistrement du handler
    if (this.pendingPackets.length > 0) {
      const toReplay = this.pendingPackets.splice(0);
      console.log(`[BleGateway] ▶ Replay de ${toReplay.length} paquet(s) bufferisé(s)`);
      for (const pkt of toReplay) {
        try { handler(pkt); } catch (e) { console.error('[BleGateway] Erreur replay paquet:', e); }
      }
    }
  }
  onDeviceInfo(cb: (info: BleDeviceInfo) => void): void           { this.deviceInfoCallback = cb; }
  onIncomingMessage(cb: (msg: MeshCoreIncomingMsg) => void): void { this.incomingMessageCallback = cb; }
  onContactDiscovered(cb: (c: MeshCoreContact) => void): void     { this.contactDiscoveredCallback = cb; }
  onContacts(cb: (contacts: MeshCoreContact[]) => void): void     { this.contactsCallback = cb; }
  /**
   * Notifié quand le firmware confirme la livraison LoRa d'un message
   * (PUSH_SEND_CONFIRMED). `localMsgId` est le DBMessage.id passé à
   * sendDirectMessage(); `null` si l'expected_ack n'a pas pu être mappé
   * (RESP_SENT pas reçu ou ACK déjà consommé en cas de duplicata firmware).
   */
  onSendConfirmed(cb: (localMsgId: string | null, ackCode: number, rtt: number) => void): void {
    this.sendConfirmedCallback = cb;
  }
  /**
   * Notifié quand le firmware accepte un message (RESP_SENT) — l'app peut alors
   * marquer le message « sent » (transmis sur LoRa, pas encore livré). Le passage
   * « sent → delivered » se fait via onSendConfirmed.
   */
  onMessageAccepted(cb: (localMsgId: string, expectedAck: number, estTimeoutMs: number, isFlood: boolean) => void): void {
    this.messageAcceptedCallback = cb;
  }
  onDisconnect(cb: () => void): void                  { this.disconnectCallback = cb; }
  onBattery(cb: (volts: number) => void): void        { this.batteryCallback = cb; }
  onStats(cb: (stats: MeshCoreStats) => void): void   { this.statsCallback = cb; }
  onNeighbours(cb: (n: MeshCoreNeighbour[]) => void): void { this.neighboursCallback = cb; }
  onStatusResponse(cb: (s: MeshCoreStatusResponse) => void): void { this.statusResponseCallback = cb; }
  onPathUpdated(cb: (prefix: string) => void): void   { this.pathUpdatedCallback = cb; }
  onLoginResult(cb: (success: boolean) => void): void { this.loginResultCallback = cb; }
  onExportContact(cb: (data: Uint8Array) => void): void { this.exportContactCallback = cb; }

  getDeviceInfo(): BleDeviceInfo | null    { return this.deviceInfo; }
  isConnected(): boolean                   { return this.connectedId !== null; }
  getChannelConfig(index: number): ChannelConfig | undefined { return this.channelConfigs.get(index); }

  getConnectedDevice(): BleGatewayDevice | null {
    if (!this.connectedId) return null;
    return { id: this.connectedId, name: this.deviceInfo?.name || 'MeshCore', rssi: -70 };
  }

  async destroy(): Promise<void> { await this.disconnect(); }

  // ── Privé : Frame handler ─────────────────────────────────────────

  private handleFrame(data: Uint8Array): void {
    if (data.length === 0) return;
    const code    = data[0];
    const payload = data.slice(1);
    console.log(`[BleGateway] Frame reçu code=0x${code.toString(16).padStart(2,'0')} (${payload.length}B)`);

    switch (code) {
      case RESP_OK:
        break;

      case RESP_ERR:
        console.warn(`[BleGateway] RESP_ERR code=${payload[0]}`);
        break;

      case RESP_CONTACTS_START: {
        this.pendingContacts = [];
        if (payload.length >= 4) {
          const count = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
          console.log(`[BleGateway] Contacts start: ${count} attendus`);
        }
        break;
      }

      case RESP_CONTACT:
        this.parseContact(payload);
        break;

      case PUSH_NEW_ADVERT:
        this.parseNewAdvert(payload);
        break;

      case RESP_END_CONTACTS:
        console.log(`[BleGateway] ${this.pendingContacts.length} contacts chargés`);
        this.contactsCallback?.([...this.pendingContacts]);
        break;

      case RESP_SELF_INFO:
        this.parseSelfInfo(payload);
        break;

      case RESP_SENT:
        this.parseRespSent(payload);
        break;

      case RESP_DIRECT_MSG_OLD:
        // Format library v1.11 : [pubKeyPrefix:6][pathLen:1][txtType:1][timestamp:4LE][text...]
        // Utilisé par certains firmware comme fallback (sans SNR)
        this.parseDirectMsgLegacy(payload);
        break;

      case RESP_CHANNEL_MSG_OLD:
        // Format library v1.11 : [channelIdx:1][pathLen:1][txtType:1][timestamp:4LE][text...]
        // Utilisé par certains firmware comme fallback (sans SNR)
        this.parseChannelMsgLegacy(payload);
        break;

      case RESP_CURR_TIME:
        if (payload.length >= 4) {
          const deviceTime = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
          console.log(`[BleGateway] RESP_CURR_TIME: ${new Date(deviceTime * 1000).toISOString()}`);
        }
        break;

      case RESP_NO_MORE_MSGS:
        console.log('[BleGateway] RESP_NO_MORE_MSGS — file vide');
        break;

      case RESP_EXPORT_CONTACT:
        console.log(`[BleGateway] RESP_EXPORT_CONTACT: ${payload.length}B`);
        this.exportContactCallback?.(payload);
        break;

      case RESP_BATT_STORAGE:
        // Firmware: [battery_mv:2 uint16 LE][used_kb:4 uint32 LE][total_kb:4 uint32 LE]
        if (payload.length >= 2) {
          const mv = new DataView(payload.buffer, payload.byteOffset).getUint16(0, true);
          const volts = mv / 1000.0;
          console.log(`[BleGateway] Batterie: ${mv}mV = ${volts.toFixed(3)}V`);
          this.batteryCallback?.(volts);
        }
        break;

      case RESP_DEVICE_INFO:
        console.log('[BleGateway] RESP_DEVICE_INFO reçu');
        break;

      case RESP_DISABLED:
        console.log('[BleGateway] RESP_DISABLED — commande non supportée sur ce firmware');
        break;

      case RESP_STATS:
        this.parseStats(payload);
        break;

      case RESP_DIRECT_MSG_V3:
        // PACKET_CONTACT_MSG_RECV_V3 (0x10) — firmware v1.13
        // [SNR:1][reserved:2][pub_key_prefix:6][path_len:1][txt_type:1][timestamp:4LE][text...]
        this.parseDirectMsgV3(payload);
        break;

      case RESP_CHANNEL_MSG_V3:
        // PACKET_CHANNEL_MSG_RECV_V3 (0x11) — firmware v1.13
        // [SNR:1][reserved:2][channelIdx:1][path_len:1][txt_type:1][timestamp:4LE][text...]
        this.parseChannelMsgV3(payload);
        break;

      case RESP_CHANNEL_DATA_RECV:
        // PACKET_CHANNEL_DATA_RECV (0x1B) — firmware v1.15.0
        // [SNR:1][reserved:1][reserved:1][channelIdx:1][path_len:1][data_type:2LE][data_len:1][data...]
        this.parseChannelDataRecv(payload);
        break;

      case RESP_CHANNEL_INFO:
        this.parseChannelInfo(payload);
        break;

      case RESP_CUSTOM_VARS:
        console.log('[BleGateway] RESP_CUSTOM_VARS reçu');
        break;

      case RESP_AUTOADD_CONFIG:
        console.log('[BleGateway] RESP_AUTOADD_CONFIG reçu');
        break;

      case RESP_ALLOWED_REPEAT_FREQ:
        console.log('[BleGateway] RESP_ALLOWED_REPEAT_FREQ reçu (v1.15)');
        break;

      case RESP_DEFAULT_FLOOD_SCOPE:
        console.log('[BleGateway] RESP_DEFAULT_FLOOD_SCOPE reçu (v1.15)');
        break;

      case PUSH_ADVERT:
        this.parseAdvert(payload);
        break;

      case PUSH_PATH_UPDATED:
        if (payload.length >= 6) {
          const prefix = Array.from(payload.slice(0, 6)).map((b) => b.toString(16).padStart(2, '0')).join('');
          console.log(`[BleGateway] PUSH_PATH_UPDATED: ${prefix}`);
          this.pathUpdatedCallback?.(prefix);
        }
        break;

      case PUSH_SEND_CONFIRMED:
        this.parseSendConfirmed(payload);
        break;

      case PUSH_MSG_WAITING:
        // Device signale qu'un message est en attente — OBLIGATOIRE de le récupérer
        console.log('[BleGateway] PUSH_MSG_WAITING → syncNextMessage()');
        this.syncNextMessage().catch((e) => console.warn('[BleGateway] syncNextMessage:', e));
        break;

      case PUSH_LOGIN_SUCCESS:
        console.log('[BleGateway] PUSH_LOGIN_SUCCESS — room server connecté');
        this.loginResultCallback?.(true);
        break;

      case PUSH_LOGIN_FAIL:
        console.log('[BleGateway] PUSH_LOGIN_FAIL — connexion room server refusée');
        this.loginResultCallback?.(false);
        break;

      case PUSH_STATUS_RESPONSE:
        this.parseStatusResponse(payload);
        break;

      case PUSH_TRACE_DATA:
        console.log(`[BleGateway] PUSH_TRACE_DATA: ${payload.length}B`);
        break;

      case PUSH_BINARY_RESPONSE:
        this.parseBinaryResponse(payload);
        break;

      case PUSH_PATH_DISCOVERY_RESPONSE:
        // [pub_key_prefix:6][out_path_len:1][out_path][in_path_len:1][in_path]
        console.log(`[BleGateway] PUSH_PATH_DISCOVERY_RESPONSE: ${payload.length}B`);
        break;

      case PUSH_CONTROL_DATA:
        // v8+ firmware (v1.15) — données de contrôle, format dépendant de l'app
        console.log(`[BleGateway] PUSH_CONTROL_DATA: ${payload.length}B`);
        break;

      case PUSH_CONTACT_DELETED:
        // v1.15 — firmware a supprimé un contact (auto-add overflow)
        // Payload format = writeContactRespFrame() : [pub_key:32][type:1][flags:1][out_path_len:1][out_path:64][name:32][last_advert:4][lat:4][lon:4][lastmod:4]
        if (payload.length >= 32) {
          const pubkeyHex = Array.from(payload.slice(0, 32))
            .map((b) => b.toString(16).padStart(2, '0')).join('');
          const pubkeyPrefix = pubkeyHex.slice(0, 12);
          console.log(`[BleGateway] PUSH_CONTACT_DELETED: ${pubkeyPrefix}`);
          // Retire ce contact du buffer en cours d'agrégation si présent
          this.pendingContacts = this.pendingContacts.filter((c) => c.pubkeyPrefix !== pubkeyPrefix);
        }
        break;

      case PUSH_CONTACTS_FULL:
        // v1.15 — stockage contacts plein côté firmware
        console.warn('[BleGateway] PUSH_CONTACTS_FULL — stockage contacts saturé sur le device');
        break;

      case PUSH_RAW_DATA:
        // Données LoRa brutes — BitMesh custom firmware
        if (payload.length > RAW_PUSH_HEADER_SIZE) {
          const snr  = (payload[0] << 24 >> 24) / 4;
          const rssi = payload[1] << 24 >> 24;
          const raw  = payload.slice(RAW_PUSH_HEADER_SIZE);
          console.log(`[BleGateway] RawData SNR:${snr} RSSI:${rssi} (${raw.length}B)`);
          this.deliverRawPacket(raw);
        }
        break;

      default:
        console.log(`[BleGateway] Code non géré 0x${code.toString(16)}`);
    }
  }

  // ── Privé : SelfInfo parser ──────────────────────────────────────

  /**
   * Layout SelfInfo (code=5) — source : MyMesh.cpp firmware v1.13.0
   *   [0]      type       (1B)
   *   [1]      txPower    (1B)
   *   [2]      maxTxPower (1B)
   *   [3..34]  publicKey  (32B)   ← PAS de byte "flags" entre maxTxPower et pubkey
   *   [35..38] advLat     (int32 LE, ×1e-6)
   *   [39..42] advLon     (int32 LE, ×1e-6)
   *   [43..46] multi_acks+adv_loc_policy+telemetry+manual_contacts
   *   [47..50] radioFreq  (uint32 LE, Hz)
   *   [51..54] radioBw    (uint32 LE, Hz)
   *   [55]     radioSf    (uint8)
   *   [56]     radioCr    (uint8)
   *   [57+]    name       (UTF-8, null-terminated)
   */
  private parseSelfInfo(payload: Uint8Array): void {
    if (payload.length < 57) {
      console.warn('[BleGateway] SelfInfo trop court:', payload.length);
      return;
    }
    const view = new DataView(payload.buffer, payload.byteOffset);
    let off = 0;

    /* type */         off++;
    const txPower    = payload[off++];
    const maxTxPower = payload[off++];
    // IMPORTANT : PAS de byte "flags" ici — pubkey commence directement à off=3

    const pubkeyBytes = payload.slice(off, off + 32); off += 32;
    const publicKey   = Array.from(pubkeyBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

    const advLatRaw = view.getInt32(off, true);  off += 4;
    const advLonRaw = view.getInt32(off, true);  off += 4;
    off += 4; // multi_acks + adv_loc_policy + telemetry + manual_contacts

    const radioFreqHz = view.getUint32(off, true); off += 4;
    const radioBwHz   = view.getUint32(off, true); off += 4;
    const radioSf     = payload[off++];
    const radioCr     = payload[off++];

    const name = new TextDecoder()
      .decode(payload.slice(off))
      .replace(/\0/g, '')
      .trim() || 'MeshCore';

    const info: BleDeviceInfo = {
      name, publicKey, txPower, maxTxPower, radioFreqHz, radioBwHz, radioSf, radioCr,
      advLat: advLatRaw / 1e6,
      advLon: advLonRaw / 1e6,
    };
    this.deviceInfo = info;
    console.log('[BleGateway] SelfInfo:', {
      name,
      freq: `${(radioFreqHz / 1e6).toFixed(3)} MHz`,
      sf: radioSf,
      bw: `${radioBwHz / 1000} kHz`,
      txPower,
    });

    this.deviceInfoCallback?.(info);

    // SetTime obligatoire après SelfInfo
    const ts     = Math.floor(Date.now() / 1000);
    const timeBuf = new Uint8Array(4);
    new DataView(timeBuf.buffer).setUint32(0, ts, true);
    this.sendFrame(CMD_SET_TIME, timeBuf)
      .then(() => console.log('[BleGateway] SetTime envoyé:', ts))
      .catch((e) => console.warn('[BleGateway] SetTime échoué:', e));

    // Résoudre les waitForSelfInfo en attente
    this.awaitingSelfInfo = false;
    this.clearSelfInfoRetry();
    const resolvers = [...this.selfInfoResolvers];
    this.selfInfoResolvers = [];
    resolvers.forEach((r) => r());
  }

  // ── Privé : Parsers messages V3 ──────────────────────────────────

  private parseDirectMsgV3(payload: Uint8Array): void {
    // [SNR:1][reserved:2][pub_key_prefix:6][path_len:1][txt_type:1][timestamp:4LE][text...]
    if (payload.length <= 15) {
      console.warn('[BleGateway] RESP_DIRECT_MSG_V3 trop court:', payload.length);
      return;
    }
    const snr              = (payload[0] << 24 >> 24) / 4;
    const senderPubkeyPrefix = Array.from(payload.slice(3, 9))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    const pathLen  = payload[9];
    const txtType  = payload[10];
    const ts         = new DataView(payload.buffer, payload.byteOffset).getUint32(11, true);
    // txt_type==2 (TXT_TYPE_SIGNED_PLAIN) : 4-byte signature prefix before text
    const textOffset = txtType === 2 ? 19 : 15;
    const text       = new TextDecoder().decode(payload.slice(textOffset)).replace(/\0/g, '');

    console.log(`[BleGateway] DM de ${senderPubkeyPrefix} SNR=${snr}: "${text.slice(0, 40)}"`);

    const msg: MeshCoreIncomingMsg = {
      type: 'direct', senderPubkeyPrefix, pathLen, txtType, timestamp: ts, text, snr,
    };
    this.incomingMessageCallback?.(msg);
    this.deliverCompanionTextPacket(senderPubkeyPrefix, text, false);
  }

  private parseChannelMsgV3(payload: Uint8Array): void {
    // [SNR:1][reserved:2][channelIdx:1][path_len:1][txt_type:1][timestamp:4LE][text...]
    if (payload.length <= 10) {
      console.warn('[BleGateway] RESP_CHANNEL_MSG_V3 trop court:', payload.length);
      return;
    }
    const snr        = (payload[0] << 24 >> 24) / 4;
    const channelIdx = payload[3];
    const pathLen    = payload[4];
    const txtType    = payload[5];
    const ts         = new DataView(payload.buffer, payload.byteOffset).getUint32(6, true);
    // txt_type==2 (TXT_TYPE_SIGNED_PLAIN) : 4-byte signature prefix avant le texte
    const textOffset = txtType === 2 ? 14 : 10;
    const text       = new TextDecoder().decode(payload.slice(textOffset)).replace(/\0/g, '');

    console.log(`[BleGateway] Canal ch=${channelIdx} SNR=${snr}: "${text.slice(0, 40)}"`);

    const msg: MeshCoreIncomingMsg = {
      type: 'channel', channelIdx, senderPubkeyPrefix: '', pathLen, txtType, timestamp: ts, text, snr,
    };
    this.incomingMessageCallback?.(msg);
    this.deliverCompanionTextPacket('', text, true, channelIdx);
  }

  private parseChannelDataRecv(payload: Uint8Array): void {
    // [SNR:1][reserved:1][reserved:1][channelIdx:1][path_len:1][data_type:2LE][data_len:1][data...]
    if (payload.length < 8) {
      console.warn('[BleGateway] RESP_CHANNEL_DATA_RECV trop court:', payload.length);
      return;
    }
    const snr        = (payload[0] << 24 >> 24) / 4;
    const channelIdx = payload[3];
    const pathLen    = payload[4];
    const dataType   = new DataView(payload.buffer, payload.byteOffset).getUint16(5, true);
    const dataLen    = payload[7];
    const data       = payload.slice(8, 8 + dataLen);

    console.log(`[BleGateway] ChannelDataRecv ch=${channelIdx} type=${dataType} len=${dataLen} SNR=${snr}`);
    // Pour l'instant on route comme un message canal texte vide (ou on pourrait ajouter un type 'channelData' à MeshCoreIncomingMsg)
    const msg: MeshCoreIncomingMsg = {
      type: 'channel', channelIdx, senderPubkeyPrefix: '', pathLen, txtType: 0, timestamp: Math.floor(Date.now() / 1000), text: `[ChannelData type=${dataType}]`, snr,
    };
    this.incomingMessageCallback?.(msg);
  }

  private parseDirectMsgLegacy(payload: Uint8Array): void {
    // Format library v1.11 (code=7) : [pubKeyPrefix:6][pathLen:1][txtType:1][timestamp:4LE][text...]
    if (payload.length < 12) {
      console.warn('[BleGateway] RESP_DIRECT_MSG_OLD trop court:', payload.length);
      return;
    }
    const senderPubkeyPrefix = Array.from(payload.slice(0, 6))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    const pathLen = payload[6];
    const txtType = payload[7];
    const ts      = new DataView(payload.buffer, payload.byteOffset).getUint32(8, true);
    // txt_type==2 (TXT_TYPE_SIGNED_PLAIN) : 4-byte signature prefix avant le texte (doc officielle)
    const textOffset = txtType === 2 ? 16 : 12;
    const text    = new TextDecoder().decode(payload.slice(textOffset)).replace(/\0/g, '');

    console.log(`[BleGateway] DM (legacy) de ${senderPubkeyPrefix}: "${text.slice(0, 40)}"`);
    const msg: MeshCoreIncomingMsg = {
      type: 'direct', senderPubkeyPrefix, pathLen, txtType, timestamp: ts, text,
    };
    this.incomingMessageCallback?.(msg);
    this.deliverCompanionTextPacket(senderPubkeyPrefix, text, false);
  }

  private parseChannelMsgLegacy(payload: Uint8Array): void {
    // Format library v1.11 (code=8) : [channelIdx:1][pathLen:1][txtType:1][timestamp:4LE][text...]
    if (payload.length < 8) {
      console.warn('[BleGateway] RESP_CHANNEL_MSG_OLD trop court:', payload.length);
      return;
    }
    const channelIdx = payload[0];
    const pathLen    = payload[1];
    const txtType    = payload[2];
    const ts         = new DataView(payload.buffer, payload.byteOffset).getUint32(3, true);
    // ✅ FIX: txtType==2 (TXT_TYPE_SIGNED_PLAIN) ajoute un préfixe 4 bytes avant le texte
    // Même traitement que parseDirectMsgLegacy et parseChannelMsgV3
    const textOffset = txtType === 2 ? 11 : 7;
    const text       = new TextDecoder().decode(payload.slice(textOffset)).replace(/\0/g, '');

    console.log(`[BleGateway] Canal (legacy) ch=${channelIdx}: "${text.slice(0, 40)}"`);
    const msg: MeshCoreIncomingMsg = {
      type: 'channel', channelIdx, senderPubkeyPrefix: '', pathLen, txtType, timestamp: ts, text,
    };
    this.incomingMessageCallback?.(msg);
    this.deliverCompanionTextPacket('', text, true, channelIdx);
  }

  private parseChannelInfo(payload: Uint8Array): void {
    if (payload.length < 1) return;
    const channelIdx = payload[0];

    // Format v1.12: [idx:1][name:32][secret:32] = 65B
    // Format v1.13: [idx:1][name:32][secret_hash:16] = 49B
    if (payload.length >= 49) {
      const nameBytes = payload.slice(1, 33);
      const name      = new TextDecoder().decode(nameBytes).replace(/\0/g, '').trim();
      const secretLen = payload.length >= 65 ? 32 : 16;
      const secret    = payload.slice(33, 33 + secretLen);

      console.log(`[BleGateway] Canal ${channelIdx}: "${name}" (${payload.length}B)`);
      this.channelConfigs.set(channelIdx, { index: channelIdx, name, secret, configured: name.length > 0 });

      // Si on attendait SelfInfo mais qu'on reçoit des infos de canal → le handshake est ok
      if (this.awaitingSelfInfo) {
        this.awaitingSelfInfo = false;
        this.clearSelfInfoRetry();
        const resolvers = [...this.selfInfoResolvers];
        this.selfInfoResolvers = [];
        resolvers.forEach((r) => r());
      }
    } else {
      console.log(`[BleGateway] Canal ${channelIdx} non configuré (${payload.length}B)`);
    }
  }

  private parseStats(payload: Uint8Array): void {
    if (payload.length < 1) return;
    const typeIdx = payload[0]; // 0=core, 1=radio, 2=packets
    const types: Array<'core' | 'radio' | 'packets'> = ['core', 'radio', 'packets'];
    const type = types[typeIdx] ?? 'core';
    const view = new DataView(payload.buffer, payload.byteOffset);
    const raw: Record<string, number> = {};

    if (typeIdx === 0) {
      // CORE: [type:1][battery_mv:2 uint16][uptime_secs:4 uint32][queue_len:1 uint8]
      // Total payload: 8 bytes (source de vérité: meshcore.js v1.13)
      if (payload.length >= 3)  raw['battery_mv']   = view.getUint16(1, true);
      if (payload.length >= 7)  raw['uptime_secs']  = view.getUint32(3, true);
      if (payload.length >= 8)  raw['queue_len']    = payload[7];
    } else if (typeIdx === 1) {
      // RADIO: [type:1][noise_floor:2 int16][last_rssi:1 int8][last_snr:1 int8][tx_air_secs:4 uint32][rx_air_secs:4 uint32]
      // Total payload: 13 bytes
      if (payload.length >= 3)  raw['noise_floor']   = view.getInt16(1, true);
      if (payload.length >= 4)  raw['last_rssi']     = view.getInt8(3);
      if (payload.length >= 5)  raw['last_snr']      = view.getInt8(4);
      if (payload.length >= 9)  raw['tx_air_secs']   = view.getUint32(5, true);
      if (payload.length >= 13) raw['rx_air_secs']   = view.getUint32(9, true);
    } else {
      // PACKETS: [type:1][recv:4][sent:4][n_sent_flood:4][n_sent_direct:4][n_recv_flood:4][n_recv_direct:4][n_recv_errors:4]
      // Total payload: 29 bytes
      const labels = ['recv', 'sent', 'n_sent_flood', 'n_sent_direct', 'n_recv_flood', 'n_recv_direct', 'n_recv_errors'];
      for (let i = 0; i < labels.length && 1 + i * 4 + 4 <= payload.length; i++) {
        raw[labels[i]] = view.getUint32(1 + i * 4, true);
      }
    }

    console.log(`[BleGateway] Stats [${type}]:`, raw);
    this.statsCallback?.({ type, raw });
  }

  /**
   * Source : MyMesh.cpp:662-668 — out_frame layout pour PUSH_CODE_BINARY_RESPONSE (0x8C) :
   *   [0] PUSH_CODE_BINARY_RESPONSE
   *   [1] reserved = 0
   *   [2..5] tag (uint32 LE — doit matcher `tag` retourné par RESP_CODE_SENT)
   *   [6..] response data (du nœud distant, données déjà dé-taggées : data[4..])
   * → payload (code strippé) : [reserved:1][tag:4][data...]
   *
   * Le type de requête (neighbours/telemetry) n'est PAS dans la réponse — l'app
   * doit le déduire du `tag` qu'elle a envoyé (stocké lors du CMD_SEND_BINARY_REQ).
   * Pour l'instant on tente un parsing "voisins" si la taille correspond au format.
   */
  private parseBinaryResponse(payload: Uint8Array): void {
    if (payload.length < 5) return;
    const view = new DataView(payload.buffer, payload.byteOffset);
    const tag  = view.getUint32(1, true);
    const data = payload.slice(5);

    // Format voisins : [count:1][entry × count] où entry = [prefix:6][snr:i8][rssi:i8][tx_pwr:1][last_heard:4LE] = 13B
    // Heuristique : si data.length >= 1 et (data.length - 1) divisible par 13, probablement des voisins
    if (data.length >= 1 && (data.length - 1) % 13 === 0) {
      const count = data[0];
      const entrySize = 13;
      if (count * entrySize === data.length - 1) {
        const neighbours: MeshCoreNeighbour[] = [];
        for (let i = 0; i < count; i++) {
          const off = 1 + i * entrySize;
          const prefix = Array.from(data.slice(off, off + 6))
            .map((b) => b.toString(16).padStart(2, '0')).join('');
          const snr     = (data[off + 6] << 24 >> 24) / 4;
          const rssi    = data[off + 7] << 24 >> 24;
          const txPower = data[off + 8];
          const lastHeard = new DataView(data.buffer, data.byteOffset + off + 9).getUint32(0, true);
          neighbours.push({
            pubkeyPrefix: prefix,
            name: `Node-${prefix.slice(0, 6).toUpperCase()}`,
            snr, rssi, txPower, lastHeard,
          });
        }
        console.log(`[BleGateway] Voisins (${neighbours.length}) tag=0x${tag.toString(16)}`);
        this.neighboursCallback?.(neighbours);
        return;
      }
    }

    console.log(`[BleGateway] BinaryResponse tag=0x${tag.toString(16)} data=${data.length}B`);
  }

  private parseStatusResponse(payload: Uint8Array): void {
    // Source : MyMesh.cpp:640-646 — out_frame layout :
    //   [0] PUSH_CODE_STATUS_RESPONSE
    //   [1] reserved = 0
    //   [2..7] contact pub_key_prefix (6 bytes)
    //   [8..] response data (original packet payload[4..], tag-stripped)
    // → payload (code strippé) : [reserved:1][prefix:6][data...]
    if (payload.length < 7) return;
    const prefix = Array.from(payload.slice(1, 7))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    // data[] après prefix est le contenu brut de la réponse status du nœud distant.
    // Pour un TelemetryResponse classique le premier champ est souvent battery_mv (uint16 LE).
    let batteryVoltage: number | undefined;
    let text: string | undefined;
    if (payload.length >= 9) {
      const mv = new DataView(payload.buffer, payload.byteOffset).getUint16(7, true);
      if (mv > 1000 && mv < 20000) batteryVoltage = mv / 1000; // 1V..20V plausible
    }
    if (payload.length > 9) {
      // Essayer de décoder le reste comme UTF-8 (souvent du CLI output)
      text = new TextDecoder().decode(payload.slice(7)).replace(/\0/g, '').trim();
    }
    console.log(`[BleGateway] StatusResponse ${prefix}: batt=${batteryVoltage?.toFixed(2)}V`);
    this.statusResponseCallback?.({ pubkeyPrefix: prefix, batteryVoltage, text, rawPayload: payload });
  }

  /** PUSH_ADVERT (0x80) — format court : uniquement la pubkey (32 bytes) */
  private parseAdvert(payload: Uint8Array): void {
    if (payload.length < 32) return;
    const pubkeyBytes  = payload.slice(0, 32);
    const pubkeyHex    = Array.from(pubkeyBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    const pubkeyPrefix = pubkeyHex.slice(0, 12);
    const name = `Node-${pubkeyPrefix.slice(0, 6).toUpperCase()}`;

    console.log(`[BleGateway] PUSH_ADVERT: "${name}" ${pubkeyPrefix}...`);
    const contact: MeshCoreContact = {
      publicKey: pubkeyBytes, pubkeyHex, pubkeyPrefix, name,
      lastSeen: Math.floor(Date.now() / 1000),
    };
    this.contactDiscoveredCallback?.(contact);
  }

  /** PUSH_NEW_ADVERT (0x8A) — format complet (même layout que RESP_CONTACT) :
   * [pubkey:32][type:1][flags:1][outPathLen:1][outPath:64][advName:32][lastAdvert:4LE][advLat:4LE][advLon:4LE][lastMod:4LE] = 147 bytes
   */
  private parseNewAdvert(payload: Uint8Array): void {
    if (payload.length < 147) {
      console.warn('[BleGateway] PUSH_NEW_ADVERT trop court:', payload.length);
      return;
    }
    const pubkeyBytes  = payload.slice(0, 32);
    const pubkeyHex    = Array.from(pubkeyBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    const pubkeyPrefix = pubkeyHex.slice(0, 12);
    const nameBytes    = payload.slice(99, 131);
    const name         = new TextDecoder().decode(nameBytes).replace(/\0/g, '').trim()
      || `Node-${pubkeyPrefix.slice(0, 6).toUpperCase()}`;
    const view         = new DataView(payload.buffer, payload.byteOffset);
    const lastSeen     = view.getUint32(131, true);
    const latRaw       = view.getInt32(135, true);
    const lonRaw       = view.getInt32(139, true);
    const contact: MeshCoreContact = {
      publicKey: pubkeyBytes, pubkeyHex, pubkeyPrefix, name, lastSeen,
      lat: latRaw !== 0 ? latRaw / 1e6 : undefined,
      lng: lonRaw !== 0 ? lonRaw / 1e6 : undefined,
    };
    this.contactDiscoveredCallback?.(contact);
    console.log(`[BleGateway] PUSH_NEW_ADVERT: "${name}" ${pubkeyPrefix}`);
  }

  private parseSendConfirmed(payload: Uint8Array): void {
    // Source : MyMesh.cpp:413-418 processAck() — 9 bytes total dont code=0x82
    //   out_frame[0] = PUSH_CODE_SEND_CONFIRMED;
    //   memcpy(&out_frame[1], data, 4);              // 4-byte ACK hash
    //   memcpy(&out_frame[5], &trip_time, 4);        // uint32 LE trip_time ms
    // → payload (code strippé) : [ack_hash:4][trip_time:4] = 8 bytes
    // L'ACK hash identifie quel message a été livré — doit être comparé au
    // `expected_ack` reçu dans RESP_CODE_SENT (CMD_SEND_TXT_MSG response).
    if (payload.length < 8) {
      console.warn('[BleGateway] PUSH_SEND_CONFIRMED trop court:', payload.length);
      return;
    }
    const view = new DataView(payload.buffer, payload.byteOffset);
    const ackHash = Array.from(payload.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    const roundTripMs = view.getUint32(4, true);
    // Convertir hex 4-byte en uint32 (little-endian, comme `expected_ack` côté firmware)
    const ackHashUint32 = view.getUint32(0, true);

    // Lookup le localMsgId mappé via RESP_SENT.expected_ack (cf. parseRespSent).
    // Le firmware peut renvoyer le même ACK plusieurs fois (cf. MyMesh.cpp:420
    // « NOTE: the same ACK can be received multiple times! ») — on ne supprime
    // donc le mapping qu'à la première réception, et les suivantes seront livrées
    // avec localMsgId=null (l'app peut alors ignorer ou idempotenter).
    const localMsgId = this.expectedAckToMsgId.get(ackHashUint32) ?? null;
    if (localMsgId) this.expectedAckToMsgId.delete(ackHashUint32);

    console.log(`[BleGateway] PUSH_SEND_CONFIRMED ack=${ackHash} RTT:${roundTripMs}ms${localMsgId ? ` msgId=${localMsgId}` : ''}`);
    this.sendConfirmedCallback?.(localMsgId, ackHashUint32, roundTripMs);
  }

  /**
   * Parse RESP_CODE_SENT (0x06) — réponse firmware à CMD_SEND_TXT_MSG.
   * Format firmware v1.13/v1.15 (MyMesh.cpp:1092-1096) :
   *   [0] route_flag : 0=direct, 1=flood
   *   [1..4] expected_ack (uint32 LE) — sera renvoyé dans PUSH_SEND_CONFIRMED
   *   [5..8] est_timeout (uint32 LE, ms) — durée estimée avant ACK
   *
   * On pop le localMsgId en tête de file (FIFO ordonnée par les commandes envoyées)
   * et on l'enregistre dans expectedAckToMsgId pour pouvoir corréler le futur
   * PUSH_SEND_CONFIRMED. Si expected_ack=0 (canal/broadcast — pas d'ACK attendu),
   * on saute le mapping mais on consomme quand même l'id de la file.
   */
  private parseRespSent(payload: Uint8Array): void {
    if (payload.length < 9) {
      // RESP_SENT minimum 9B — sinon firmware ancien ou frame corrompue
      console.warn('[BleGateway] RESP_SENT trop court:', payload.length);
      this.pendingMsgIdQueue.shift(); // consomme quand même
      return;
    }
    const view = new DataView(payload.buffer, payload.byteOffset);
    const isFlood     = payload[0] === 1;
    const expectedAck = view.getUint32(1, true);
    const estTimeout  = view.getUint32(5, true);

    const localMsgId = this.pendingMsgIdQueue.shift();
    if (!localMsgId) {
      console.log(`[BleGateway] RESP_SENT (orphelin, pas de msgId tracé) ack=0x${expectedAck.toString(16)} timeout=${estTimeout}ms ${isFlood ? 'flood' : 'direct'}`);
      return;
    }

    if (expectedAck !== 0) {
      // Garde-fou anti-fuite : trim l'entrée la plus ancienne si on dépasse la limite
      if (this.expectedAckToMsgId.size >= this.ACK_MAP_MAX) {
        const firstKey = this.expectedAckToMsgId.keys().next().value;
        if (firstKey !== undefined) this.expectedAckToMsgId.delete(firstKey);
      }
      this.expectedAckToMsgId.set(expectedAck, localMsgId);
    }

    console.log(`[BleGateway] RESP_SENT msgId=${localMsgId} ack=0x${expectedAck.toString(16)} timeout=${estTimeout}ms ${isFlood ? 'flood' : 'direct'}`);
    this.messageAcceptedCallback?.(localMsgId, expectedAck, estTimeout, isFlood);
  }

  private parseContact(payload: Uint8Array): void {
    if (payload.length < 147) {
      console.warn('[BleGateway] RESP_CONTACT trop court:', payload.length);
      return;
    }
    const pubkeyBytes  = payload.slice(0, 32);
    const pubkeyHex    = Array.from(pubkeyBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    const pubkeyPrefix = pubkeyHex.slice(0, 12);
    const nameBytes    = payload.slice(99, 131);
    const name         = new TextDecoder().decode(nameBytes).replace(/\0/g, '').trim()
      || `Node-${pubkeyPrefix.slice(0, 6).toUpperCase()}`;
    const view         = new DataView(payload.buffer, payload.byteOffset);
    const lastSeen     = view.getUint32(131, true);
    const latRaw       = view.getInt32(135, true);
    const lonRaw       = view.getInt32(139, true);
    const contact: MeshCoreContact = {
      publicKey: pubkeyBytes, pubkeyHex, pubkeyPrefix, name, lastSeen,
      lat: latRaw !== 0 ? latRaw / 1e6 : undefined,
      lng: lonRaw !== 0 ? lonRaw / 1e6 : undefined,
    };
    this.pendingContacts.push(contact);
    this.contactDiscoveredCallback?.(contact);
    console.log(`[BleGateway] Contact: "${name}" ${pubkeyPrefix}`);
  }

  // ── Privé : Delivery helpers ─────────────────────────────────────

  /**
   * Convertit un message texte Companion en MeshCorePacket pour MessagesProvider.
   * Les messages companion sont routés vers messageHandler en plus de incomingMessageCallback.
   */
  private deliverCompanionTextPacket(
    fromPubkeyHex: string,
    text: string,
    isChannel: boolean,
    channelIdx = 0
  ): void {
    try {
      // Pad pubkey prefix (6 bytes en V3) à 8 bytes pour getBigUint64
      const rawBytes = fromPubkeyHex
        ? new Uint8Array(fromPubkeyHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
        : new Uint8Array(0);
      const padded = new Uint8Array(8);
      padded.set(rawBytes.slice(0, Math.min(rawBytes.length, 8)));
      const fromNodeId = new DataView(padded.buffer).getBigUint64(0, false);

      const randomId = new Uint32Array(1);
      crypto.getRandomValues(randomId);
      const packet: MeshCorePacket = {
        version: 0x01,
        type: 0x01,   // MeshCoreMessageType.TEXT
        flags: 0x00,  // En clair (firmware a déjà déchiffré)
        ttl: 10,
        messageId: randomId[0],
        fromNodeId,
        toNodeId: 0n, // broadcast / nous
        timestamp: Math.floor(Date.now() / 1000),
        subMeshId: isChannel ? channelIdx : 0,
        payload: new TextEncoder().encode(text),
      };

      if (this.messageHandler) {
        this.messageHandler(packet);
      } else {
        // Handler pas encore enregistré (race condition startup) — on bufferise
        if (this.pendingPackets.length < this.PENDING_PACKETS_MAX) {
          this.pendingPackets.push(packet);
          console.warn(`[BleGateway] ⏸ messageHandler NULL — paquet bufferisé (${this.pendingPackets.length}/${this.PENDING_PACKETS_MAX}): "${text.slice(0, 40)}"`);
        } else {
          console.error('[BleGateway] ❌ Buffer plein — paquet définitivement perdu:', text.slice(0, 40));
        }
      }
    } catch (err) {
      console.error('[BleGateway] Erreur conversion companion packet:', err);
    }
  }

  private deliverRawPacket(rawBytes: Uint8Array): void {
    try {
      const packet = decodeMeshCorePacket(rawBytes);
      if (!packet) return;
      if (this.messageHandler) {
        this.messageHandler(packet);
      } else {
        if (this.pendingPackets.length < this.PENDING_PACKETS_MAX) {
          this.pendingPackets.push(packet);
          console.warn(`[BleGateway] ⏸ Raw packet bufferisé (${this.pendingPackets.length}/${this.PENDING_PACKETS_MAX})`);
        }
      }
    } catch (err) {
      console.error('[BleGateway] Échec décodage paquet LoRa:', err);
    }
  }

  // ── Privé : BLE write ─────────────────────────────────────────────

  private async sendFrame(cmd: number, payload: Uint8Array): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');

    const frame = new Uint8Array(1 + payload.length);
    frame[0] = cmd;
    frame.set(payload, 1);

    // Utiliser le MTU négocié ou la valeur par défaut
    const chunkSize = this.negotiatedMtu;

    for (let offset = 0; offset < frame.length; offset += chunkSize) {
      const chunk = Array.from(frame.slice(offset, offset + chunkSize));
      if (this.canWriteWithoutResponse) {
        await BleManager.writeWithoutResponse(
          this.connectedId, SERVICE_UUID, TX_UUID, chunk, chunkSize
        );
      } else {
        await BleManager.write(
          this.connectedId, SERVICE_UUID, TX_UUID, chunk, chunkSize
        );
      }
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

let _instance: BleGatewayClient | null = null;

export function getBleGatewayClient(): BleGatewayClient {
  if (!_instance) _instance = new BleGatewayClient();
  return _instance;
}

/**
 * Réinitialise le singleton BleGatewayClient
 * À appeler lors du logout ou pour forcer une reconnexion propre
 */
export function resetBleGatewayClient(): void {
  if (_instance) {
    _instance.disconnect().catch(() => { /* cleanup: ignore */ });
    _instance = null;
  }
}

/**
 * Crée une nouvelle instance du client (sans affecter le singleton global)
 * Utile pour les tests ou scénarios multi-device
 */
export function createBleGatewayClient(): BleGatewayClient {
  return new BleGatewayClient();
}
