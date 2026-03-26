/**
 * BLE Gateway Client — MeshCore Companion Protocol v1.13
 *
 * Bibliothèque : react-native-ble-manager (v12+)
 *
 * Sources de vérité :
 *   https://github.com/zjs81/meshcore-open         (Flutter officiel)
 *   meshcore_firmware/examples/companion_radio/MyMesh.cpp
 *   meshcore_firmware/docs/companion_protocol.md
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  PROTOCOLE BLE — Nordic UART Service (NUS)                          ║
 * ║  App → Device : [cmd][payload...]   sur 6e400002 (RX/write)         ║
 * ║  Device → App : [code][data...]     sur 6e400003 (TX/notify)        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Séquence connexion :
 *   1. connect() + requestMTU(185)
 *   2. retrieveServices()
 *   3. createBond() — bonding explicite PIN Android
 *   4. startNotification() sur RX (6e400003) — avec retry
 *   5. DeviceQuery  (cmd=22) [version=3]
 *   6. AppStart     (cmd=1)  → device répond SelfInfo (code=5)
 *   7. SetTime      (cmd=6)  envoyé auto dans parseSelfInfo
 *   8. configureDefaultChannels() — canal 0 public
 *   9. getContacts() — liste tous les nœuds connus
 *  10. sendSelfAdvert() — annonce notre présence sur le mesh
 */

import BleManager from 'react-native-ble-manager';
import { NativeEventEmitter, NativeModules } from 'react-native';
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
const RESP_BATT_STORAGE     = 12;  // Batterie (float32 LE, volts)
const RESP_DEVICE_INFO      = 13;  // Firmware / modèle
const RESP_DISABLED         = 15;  // Commande désactivée sur ce device
const RESP_DIRECT_MSG_V3    = 0x10; // PACKET_CONTACT_MSG_RECV_V3
const RESP_CHANNEL_MSG_V3   = 0x11; // PACKET_CHANNEL_MSG_RECV_V3
const RESP_CHANNEL_INFO     = 18;  // Info canal N
const RESP_CUSTOM_VARS      = 21;  // Variables custom
const RESP_STATS            = 24;  // Statistiques device (core/radio/packets)
const RESP_RADIO_SETTINGS   = 25;  // Paramètres radio
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

// Types de requêtes binaires (CMD_SEND_BINARY_REQ)
const BINARY_REQ_NEIGHBOURS = 0x06;

const APP_PROTOCOL_VERSION = 3;
const RAW_PUSH_HEADER_SIZE = 3;   // [snr:int8][rssi:int8][reserved:uint8]
const BLE_MAX_WRITE        = 169; // MTU 172 − 3 ATT overhead

// Canal public par défaut (canal 0, secret = 16 zéros — doc officielle MeshCore v1.13)
const DEFAULT_CHANNEL_NAME   = 'public';
const DEFAULT_CHANNEL_SECRET = new Uint8Array(16);

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
  type: 'direct' | 'channel';
  channelIdx?: number;
  senderPubkeyPrefix: string; // 12 hex chars, vide pour les messages canal
  pathLen: number;
  txtType: number;
  timestamp: number;
  text: string;
  snr?: number;
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
  private sendConfirmedCallback:     ((ackCode: number, roundTripMs: number) => void) | null = null;
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
      await BleManager.stopScan().catch(() => {});
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

    console.log(`[BleGateway] Connexion à ${deviceId}...`);
    try {

    // ── 1. Connexion BLE ──
    await BleManager.connect(deviceId);
    this.connectedId = deviceId;
    console.log('[BleGateway] Connecté');

    // ── 2. MTU 185 (meshcore-open standard) ──
    try {
      const mtu = await BleManager.requestMTU(deviceId, 185);
      console.log(`[BleGateway] MTU négocié : ${mtu}`);
    } catch {
      console.log('[BleGateway] MTU request ignoré');
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

    // ── 5. Activer notifications RX (Device → App) avec retry ──
    let notifySet = false;
    for (let attempt = 0; attempt < 3 && !notifySet; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
        await BleManager.startNotification(deviceId, SERVICE_UUID, RX_UUID);
        notifySet = true;
        console.log(`[BleGateway] Notifications activées (tentative ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, 300));
      } catch (e) {
        console.log(`[BleGateway] startNotification ${attempt + 1}/3 échoué`);
        if (attempt === 2) throw e;
      }
    }

    // Écouter les trames entrantes
    const notifListener = this.emitter.addListener(
      'BleManagerDidUpdateValueForCharacteristic',
      (data: any) => {
        if (data.peripheral !== deviceId) return;
        if (data.characteristic?.toLowerCase() !== RX_UUID.toLowerCase()) return;
        this.handleFrame(new Uint8Array(data.value));
      }
    );
    this.listeners.push(notifListener);

    // Écouter déconnexion
    const discListener = this.emitter.addListener(
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

    // ── 6. Handshake MeshCore ──
    this.awaitingSelfInfo = true;
    await this.sendFrame(CMD_DEVICE_QUERY, new Uint8Array([APP_PROTOCOL_VERSION]));
    console.log('[BleGateway] DeviceQuery envoyé');
    await new Promise((res) => setTimeout(res, 300));

    await this.sendAppStart();
    this.scheduleSelfInfoRetry();

    // Attendre SelfInfo (3s) + retry si non reçu
    const gotSelfInfo = await this.waitForSelfInfo(3000);
    if (!gotSelfInfo) {
      console.log('[BleGateway] SelfInfo non reçu — retry...');
      await this.sendFrame(CMD_DEVICE_QUERY, new Uint8Array([APP_PROTOCOL_VERSION]));
      await this.sendAppStart();
      await this.waitForSelfInfo(4000);
    }

    // ── 7. Post-connexion ──
    // Configurer canal 0 (public) pour recevoir les broadcasts
    await this.configureDefaultChannels();

    // Récupérer les canaux configurés sur le device
    this.getChannels(4).catch((e) => console.warn('[BleGateway] getChannels:', e));

    // Récupérer les contacts (nœuds connus)
    this.getContacts().catch((e) => console.warn('[BleGateway] getContacts:', e));

    // S'annoncer sur le mesh
    this.sendSelfAdvert(1).catch((e) => console.warn('[BleGateway] sendSelfAdvert:', e));

    console.log('[BleGateway] Handshake terminé');
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
    if (this.connectedId) {
      console.log('[BleGateway] Déconnexion...');
      await BleManager.disconnect(this.connectedId).catch(() => {});
      this.connectedId = null;
    }
  }

  // ── AppStart / SelfInfo retry ────────────────────────────────────

  private async sendAppStart(): Promise<void> {
    // Format firmware v1.13 : payload[7+] = app_name → cmd_frame[8+]
    // [version:1][reserved:6][app_name][null]
    const appNameBytes = new TextEncoder().encode('MeshPay\0');
    const payload = new Uint8Array(7 + appNameBytes.length);
    payload[0] = APP_PROTOCOL_VERSION; // version
    // payload[1..6] = reserved zeros (déjà 0)
    payload.set(appNameBytes, 7);
    await this.sendFrame(CMD_APP_START, payload);
    console.log('[BleGateway] AppStart envoyé (v' + APP_PROTOCOL_VERSION + ')');
  }

  private scheduleSelfInfoRetry(): void {
    this.clearSelfInfoRetry();
    this.selfInfoRetryTimer = setInterval(async () => {
      if (!this.connectedId || !this.awaitingSelfInfo) {
        this.clearSelfInfoRetry();
        return;
      }
      console.log('[BleGateway] SelfInfo retry — re-envoi AppStart...');
      this.sendAppStart().catch(() => {});
    }, 3500);
  }

  private clearSelfInfoRetry(): void {
    if (this.selfInfoRetryTimer !== null) {
      clearInterval(this.selfInfoRetryTimer);
      this.selfInfoRetryTimer = null;
    }
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
    const payload = new Uint8Array(1 + encoded.length);
    payload[0] = 0x00; // path_length = 0 (broadcast)
    payload.set(encoded, 1);
    await this.sendFrame(CMD_SEND_RAW, payload);
  }

  /**
   * Envoie un DM via CMD_SEND_TXT_MSG (0x02) — firmware standard v1.13.
   * Format : [txt_type:1][attempt:1][timestamp:4LE][pub_key_prefix:6][text...]
   * Le destinataire doit être dans les contacts du device (lookupContactByPubKey).
   */
  async sendDirectMessage(pubkeyHex: string, text: string, attempt = 0): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté à un device MeshCore');

    const hexClean = pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
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
    await this.sendFrame(CMD_SEND_TXT_MSG, payload);
  }

  /**
   * Envoie un message canal via CMD_SEND_CHAN_MSG (0x03) — firmware standard v1.13.
   * Format : [reserved=0:1][channelIdx:1][timestamp:4LE][text...]
   */
  async sendChannelMessage(channelIdx: number, text: string): Promise<void> {
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

    const payload = new Uint8Array(1 + 1 + 4 + textBytes.length);
    payload[0] = 0;                  // reserved
    payload[1] = channelIdx & 0xFF;
    payload.set(tsBuf, 2);
    payload.set(textBytes, 6);

    console.log(`[BleGateway] sendChannelMessage ch=${channelIdx} (${text.length}B)`);
    await this.sendFrame(CMD_SEND_CHAN_MSG, payload);
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

  /** Réinitialiser la route vers un contact (pubkey hex 64) */
  async resetPath(pubkeyHex: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const hexClean = pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
    const prefix = new Uint8Array(hexClean.slice(0, 12).match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    await this.sendFrame(CMD_RESET_PATH, prefix);
    console.log(`[BleGateway] ResetPath: ${hexClean.slice(0, 12)}...`);
  }

  /** Supprimer un contact (pubkey hex 64) */
  async removeContact(pubkeyHex: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const hexClean = pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
    const prefix = new Uint8Array(hexClean.slice(0, 12).match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    await this.sendFrame(CMD_REMOVE_CONTACT, prefix);
    console.log(`[BleGateway] RemoveContact: ${hexClean.slice(0, 12)}...`);
  }

  /** Exporter un contact (binaire) — réponse via onExportContact */
  async exportContact(pubkeyHex: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const hexClean = pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
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
    await this.sendFrame(CMD_REBOOT, new Uint8Array(0));
    console.log('[BleGateway] Reboot envoyé');
  }

  /** Définir la portée flood (0=local, 1=single-hop, N=N-hops) */
  async setFloodScope(scope: number): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    await this.sendFrame(CMD_SET_FLOOD_SCOPE, new Uint8Array([scope & 0xFF]));
    console.log(`[BleGateway] SetFloodScope: ${scope}`);
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

  /** Connexion à un room server via mot de passe — [prefix:6][password...] */
  async sendLogin(pubkeyHex: string, password: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const hexClean = pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
    const prefix = new Uint8Array(hexClean.slice(0, 12).match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    const passBytes = new TextEncoder().encode(password);
    const payload = new Uint8Array(6 + passBytes.length);
    payload.set(prefix, 0);
    payload.set(passBytes, 6);
    await this.sendFrame(CMD_SEND_LOGIN, payload);
  }

  /** Ping statut d'un contact — réponse via onStatusResponse */
  async sendStatusReq(pubkeyHex: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');
    const hexClean = pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
    const prefix = new Uint8Array(hexClean.slice(0, 12).match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    await this.sendFrame(CMD_SEND_STATUS_REQ, prefix);
  }

  // ── Callbacks publics ────────────────────────────────────────────

  onMessage(handler: MessageHandler): void            { this.messageHandler = handler; }
  onDeviceInfo(cb: (info: BleDeviceInfo) => void): void           { this.deviceInfoCallback = cb; }
  onIncomingMessage(cb: (msg: MeshCoreIncomingMsg) => void): void { this.incomingMessageCallback = cb; }
  onContactDiscovered(cb: (c: MeshCoreContact) => void): void     { this.contactDiscoveredCallback = cb; }
  onContacts(cb: (contacts: MeshCoreContact[]) => void): void     { this.contactsCallback = cb; }
  onSendConfirmed(cb: (ackCode: number, rtt: number) => void): void { this.sendConfirmedCallback = cb; }
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

      case 0x01:
        // ACK AppStart probable
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
        this.parseContact(payload);
        break;

      case RESP_END_CONTACTS:
        console.log(`[BleGateway] ${this.pendingContacts.length} contacts chargés`);
        this.contactsCallback?.([...this.pendingContacts]);
        break;

      case RESP_SELF_INFO:
        this.parseSelfInfo(payload);
        break;

      case RESP_SENT:
        console.log('[BleGateway] RESP_SENT — message accepté par firmware, en file LoRa');
        break;

      case RESP_DIRECT_MSG_OLD:
        // Format v2 — ignoré, remplacé par RESP_DIRECT_MSG_V3 (0x10)
        break;

      case RESP_CHANNEL_MSG_OLD:
        // Format v2 — ignoré, remplacé par RESP_CHANNEL_MSG_V3 (0x11)
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
        if (payload.length >= 4) {
          const volts = new DataView(payload.buffer, payload.byteOffset).getFloat32(0, true);
          console.log(`[BleGateway] Batterie: ${volts.toFixed(2)}V`);
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

      case RESP_CHANNEL_INFO:
        this.parseChannelInfo(payload);
        break;

      case RESP_CUSTOM_VARS:
        console.log('[BleGateway] RESP_CUSTOM_VARS reçu');
        break;

      case RESP_RADIO_SETTINGS:
        console.log('[BleGateway] RESP_RADIO_SETTINGS reçu');
        break;

      case PUSH_ADVERT:
        this.parsePushAdvert(payload);
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
    const text       = new TextDecoder().decode(payload.slice(10)).replace(/\0/g, '');

    console.log(`[BleGateway] Canal ch=${channelIdx} SNR=${snr}: "${text.slice(0, 40)}"`);

    const msg: MeshCoreIncomingMsg = {
      type: 'channel', channelIdx, senderPubkeyPrefix: '', pathLen, txtType, timestamp: ts, text, snr,
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
    // Format : [type:1][key=value pairs as uint32 LE, 4B each]
    const view = new DataView(payload.buffer, payload.byteOffset);
    const raw: Record<string, number> = {};
    for (let i = 1; i + 3 < payload.length; i += 4) {
      raw[`field_${(i - 1) / 4}`] = view.getUint32(i, true);
    }
    console.log(`[BleGateway] Stats [${type}]:`, raw);
    this.statsCallback?.({ type, raw });
  }

  /**
   * Réponse binaire (CMD_SEND_BINARY_REQ) — type encodé dans premier byte
   * GetNeighbours (0x06) : [type:1][count:1][entry...] par entry:
   *   [pubkey_prefix:6][snr:int8][rssi:int8][tx_power:1][last_heard:4LE]
   */
  private parseBinaryResponse(payload: Uint8Array): void {
    if (payload.length < 2) return;
    const reqType = payload[0];

    if (reqType === BINARY_REQ_NEIGHBOURS) {
      const count = payload[1];
      const neighbours: MeshCoreNeighbour[] = [];
      let off = 2;
      for (let i = 0; i < count && off + 12 <= payload.length; i++) {
        const prefix = Array.from(payload.slice(off, off + 6))
          .map((b) => b.toString(16).padStart(2, '0')).join('');
        off += 6;
        const snr      = (payload[off++] << 24 >> 24) / 4;
        const rssi     = payload[off++] << 24 >> 24;
        const txPower  = payload[off++];
        const lastHeard = off + 3 < payload.length
          ? new DataView(payload.buffer, payload.byteOffset + off).getUint32(0, true) : 0;
        off += 4;
        neighbours.push({ pubkeyPrefix: prefix, name: `Node-${prefix.slice(0, 6).toUpperCase()}`, snr, rssi, txPower, lastHeard });
      }
      console.log(`[BleGateway] Voisins (${neighbours.length}):`, neighbours.map((n) => n.pubkeyPrefix));
      this.neighboursCallback?.(neighbours);
    } else {
      console.log(`[BleGateway] BinaryResponse type=0x${reqType.toString(16)} (${payload.length}B)`);
    }
  }

  private parseStatusResponse(payload: Uint8Array): void {
    if (payload.length < 6) return;
    const prefix = Array.from(payload.slice(0, 6))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    let batteryVoltage: number | undefined;
    let text: string | undefined;
    if (payload.length >= 10) {
      const v = new DataView(payload.buffer, payload.byteOffset).getFloat32(6, true);
      if (v > 0 && v < 20) batteryVoltage = v; // valeur raisonnable en volts
    }
    if (payload.length > 10) {
      text = new TextDecoder().decode(payload.slice(10)).replace(/\0/g, '').trim();
    }
    console.log(`[BleGateway] StatusResponse ${prefix}: batt=${batteryVoltage?.toFixed(2)}V`);
    this.statusResponseCallback?.({ pubkeyPrefix: prefix, batteryVoltage, text, rawPayload: payload });
  }

  private parsePushAdvert(payload: Uint8Array): void {
    if (payload.length < 32) return;
    const pubkeyBytes = payload.slice(0, 32);
    const pubkeyHex   = Array.from(pubkeyBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    const pubkeyPrefix = pubkeyHex.slice(0, 12);
    console.log(`[BleGateway] PUSH_ADVERT: ${pubkeyPrefix}...`);
    const contact: MeshCoreContact = {
      publicKey: pubkeyBytes, pubkeyHex, pubkeyPrefix,
      name: `Node-${pubkeyPrefix.slice(0, 6).toUpperCase()}`,
      lastSeen: Math.floor(Date.now() / 1000),
    };
    this.contactDiscoveredCallback?.(contact);
  }

  private parseSendConfirmed(payload: Uint8Array): void {
    if (payload.length < 8) return;
    const view        = new DataView(payload.buffer, payload.byteOffset);
    const ackCode     = view.getUint32(0, true);
    const roundTripMs = view.getUint32(4, true);
    console.log(`[BleGateway] PUSH_SEND_CONFIRMED ACK:${ackCode} RTT:${roundTripMs}ms`);
    this.sendConfirmedCallback?.(ackCode, roundTripMs);
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
      lat: latRaw !== 0 ? latRaw / 1e7 : undefined,
      lng: lonRaw !== 0 ? lonRaw / 1e7 : undefined,
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
    if (!this.messageHandler) return;
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
      this.messageHandler(packet);
    } catch (err) {
      console.error('[BleGateway] Erreur conversion companion packet:', err);
    }
  }

  private deliverRawPacket(rawBytes: Uint8Array): void {
    if (!this.messageHandler) return;
    try {
      const packet = decodeMeshCorePacket(rawBytes);
      if (packet) this.messageHandler(packet);
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

    for (let offset = 0; offset < frame.length; offset += BLE_MAX_WRITE) {
      const chunk = Array.from(frame.slice(offset, offset + BLE_MAX_WRITE));
      if (this.canWriteWithoutResponse) {
        await BleManager.writeWithoutResponse(
          this.connectedId, SERVICE_UUID, TX_UUID, chunk, BLE_MAX_WRITE
        );
      } else {
        await BleManager.write(
          this.connectedId, SERVICE_UUID, TX_UUID, chunk, BLE_MAX_WRITE
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
