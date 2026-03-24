/**
 * BLE Gateway Client — MeshCore Companion Protocol
 *
 * Bibliothèque : react-native-ble-manager (v12+)
 * Avantage clé vs react-native-ble-plx : createBond() explicite +
 * événement BleManagerBondingComplete → bonding MITM fiable.
 *
 * Source de vérité :
 *   https://github.com/zjs81/meshcore-open  (Flutter officiel)
 *   https://github.com/meshcore-dev/MeshCore/src/helpers/esp32/SerialBLEInterface.cpp
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  PROTOCOLE BLE — Nordic UART Service (NUS)                          ║
 * ║  Chaque write/notification = UN frame complet. Pas de framing USB.  ║
 * ║  App → Device : [cmd][payload...]   sur 6e400002 (RX/write)         ║
 * ║  Device → App : [code][data...]     sur 6e400003 (TX/notify)        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Séquence connexion (cf. meshcore_connector.dart) :
 *   1. connect() + requestMTU(185)
 *   2. retrieveServices()
 *   3. createBond()  ← NOUVEAU : bonding explicite avant toute écriture
 *   4. startNotification() sur TX (6e400003)
 *   5. DeviceQuery  (cmd=22)
 *   6. AppStart     (cmd=1)  → device répond SelfInfo (code=5)
 *   7. SetTime      (cmd=6)  envoyé auto dans parseSelfInfo
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
// Source : meshcore-open MeshCoreUuids + SerialBLEInterface.cpp (confirmés)
const SERVICE_UUID = MESHCORE_BLE.SERVICE_UUID; // 6e400001-b5a3-f393-e0a9-e50e24dcca9e
const TX_UUID      = MESHCORE_BLE.TX_CHAR_UUID; // 6e400002  App → Device (WRITE)
const RX_UUID      = MESHCORE_BLE.RX_CHAR_UUID; // 6e400003  Device → App (NOTIFY)

// ── Command codes (App → Device) ──────────────────────────────────────
const CMD_APP_START     = 1;   // Handshake principal
const CMD_SEND_TXT_MSG  = 2;   // Envoyer DM via routing firmware standard
const CMD_SEND_CHAN_MSG  = 3;   // Envoyer message sur un canal (forum)
const CMD_SET_TIME      = 6;   // Sync horloge après SelfInfo
const CMD_DEVICE_QUERY  = 22;  // Premier message (version protocole)
const CMD_SEND_RAW      = 25;  // Broadcast raw bytes sur LoRa (firmware custom BitMesh)

// ── Response / push codes (Device → App) ──────────────────────────────
const RESP_OK           = 0;
const RESP_SELF_INFO    = 5;    // Public key, radio params, nom
const RESP_DEVICE_INFO  = 13;   // Firmware/model
const RESP_DIRECT_MSG   = 0x10; // DM reçu (firmware standard MeshCore Companion)
const RESP_CHANNEL_MSG  = 0x11; // Message canal reçu (firmware standard)
const PUSH_RAW_DATA     = 0x84; // Données LoRa reçues (firmware custom BitMesh)

const APP_PROTOCOL_VERSION = 3;
const RAW_PUSH_HEADER_SIZE = 3; // [snr:int8][rssi:int8][reserved:uint8]

// MTU device = 172 → ATT data max = 172 - 3 = 169 bytes
const BLE_MAX_WRITE = 169;

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
  radioFreqHz: number; // Hz
  radioBwHz: number;   // Hz
  radioSf: number;
  radioCr: number;
  advLat: number;
  advLon: number;
}

type MessageHandler = (packet: MeshCorePacket) => void;

// ── BleGatewayClient ──────────────────────────────────────────────────

export class BleGatewayClient {
  private connectedId: string | null = null;
  private messageHandler: MessageHandler | null = null;
  private deviceInfo: BleDeviceInfo | null = null;
  private deviceInfoCallback: ((info: BleDeviceInfo) => void) | null = null;
  private listeners: ReturnType<NativeEventEmitter['addListener']>[] = [];
  private emitter: NativeEventEmitter;

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
   * Scan BLE actif — deux phases :
   *
   * Phase 1 (6s) : filtre sur Nordic UART Service UUID.
   *   Sur Android 13+, les scans non filtrés sont throttlés silencieusement.
   *   Un scan avec UUID permet le hardware-filtering natif → résultats fiables.
   *   Source doc officielle : companion_protocol.md §BLE Connection.
   *
   * Phase 2 (4s) : scan sans filtre UUID en fallback (firmware custom sans NUS UUID
   *   dans l'ADV primaire, ou device dont le service UUID est dans le SCAN_RSP).
   *
   * Phase 0 (avant scan) : inclure les devices déjà bondés — un device bondé
   *   utilise la directed advertising et n'apparaît jamais dans un scan normal.
   */
  async scanForGateways(
    onDeviceFound: (device: BleGatewayDevice) => void,
    timeoutMs = 10000
  ): Promise<void> {
    console.log('[BleGateway] Scan BLE actif...');
    const seen = new Set<string>();

    const reportDevice = (peripheral: {
      id: string;
      name?: string;
      rssi?: number;
      advertising?: { localName?: string };
    }) => {
      const name: string =
        peripheral.name ||
        peripheral.advertising?.localName ||
        '';

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

    // ── Phase 0 : devices déjà bondés (directed advertising → invisible au scan) ──
    try {
      const bonded: any[] = await BleManager.getBondedPeripherals();
      console.log(`[BleGateway] ${bonded.length} device(s) bondé(s)`);
      for (const p of bonded) {
        reportDevice(p);
      }
    } catch (e) {
      console.log('[BleGateway] getBondedPeripherals non supporté:', e);
    }

    const listener = this.emitter.addListener('BleManagerDiscoverPeripheral', reportDevice);

    // ── Phase 1 : scan filtré sur Service UUID Nordic UART (6s) ──────
    // Méthode recommandée par la doc officielle MeshCore companion_protocol.md
    // Android hardware-filter → pas de throttling sur Android 13+
    const phase1Ms = Math.round(timeoutMs * 0.6);
    try {
      await BleManager.scan({
        serviceUUIDs: [SERVICE_UUID],
        seconds: phase1Ms / 1000,
        allowDuplicates: true,
      });
      await new Promise((res) => setTimeout(res, phase1Ms));
      await BleManager.stopScan();
    } catch (e) {
      console.log('[BleGateway] Phase 1 scan erreur:', e);
    }

    // ── Phase 2 : fallback scan sans filtre (4s) ──────────────────────
    // Pour firmware custom qui ne met pas le UUID dans l'ADV primaire.
    const phase2Ms = timeoutMs - phase1Ms;
    try {
      await BleManager.scan({
        serviceUUIDs: [],
        seconds: phase2Ms / 1000,
        allowDuplicates: true,
      });
      await new Promise((res) => setTimeout(res, phase2Ms));
      await BleManager.stopScan();
    } catch (e) {
      console.log('[BleGateway] Phase 2 scan erreur:', e);
    }

    listener.remove();
    console.log(`[BleGateway] Scan terminé — ${seen.size} device(s)`);
  }

  stopScan(): void {
    BleManager.stopScan();
  }

  // ── Connect ──────────────────────────────────────────────────────

  /**
   * Connexion + bonding explicite + handshake MeshCore.
   *
   * Séquence identique à meshcore_connector.dart :
   *   connect → requestMTU → retrieveServices → createBond → startNotification
   *   → DeviceQuery → AppStart → (SelfInfo → SetTime auto)
   *
   * createBond() = LA différence clé :
   *   1. Android affiche le dialogue "Couplage avec MeshCore-XXX"
   *   2. Utilisateur entre le PIN (défaut : 123456)
   *   3. L'événement BleManagerBondingComplete confirme le succès
   *   4. SEULEMENT APRÈS → on envoie les commandes
   */
  async connect(deviceId: string, timeoutMs = 60000): Promise<void> {
    console.log(`[BleGateway] Connexion à ${deviceId}...`);

    // ── 1. Connexion BLE (link layer) ──
    await BleManager.connect(deviceId);
    this.connectedId = deviceId;
    console.log('[BleGateway] Connecté');

    // ── 2. MTU 185 (comme meshcore-open) ──
    try {
      const mtu = await BleManager.requestMTU(deviceId, 185);
      console.log(`[BleGateway] MTU négocié : ${mtu}`);
    } catch {
      console.log('[BleGateway] MTU request ignoré');
    }

    // ── 3. Découverte des services ──
    const services = await BleManager.retrieveServices(deviceId) as any;
    const hasUart = (services.services as string[])?.some(
      (s: string) => s.toLowerCase() === SERVICE_UUID.toLowerCase()
    );
    if (!hasUart) {
      await BleManager.disconnect(deviceId);
      this.connectedId = null;
      throw new Error(
        'Service Nordic UART non trouvé. Vérifiez que c\'est bien un firmware MeshCore Companion BLE.'
      );
    }
    console.log('[BleGateway] Nordic UART Service trouvé');

    // ── 4. Bonding EXPLICITE — c'est la clé ──────────────────────
    // createBond() déclenche le dialogue PIN Android et attend BleManagerBondingComplete.
    // Sans ça, les writes sur caractéristiques MITM sont rejetés silencieusement.
    await this.createBondExplicit(deviceId, 60000);

    // ── 5. Activer notifications TX (Device → App) ──
    await BleManager.startNotification(deviceId, SERVICE_UUID, RX_UUID);
    console.log('[BleGateway] Notifications TX activées (6e400003)');

    // Écouter les données entrantes
    const notifListener = this.emitter.addListener(
      'BleManagerDidUpdateValueForCharacteristic',
      (data: any) => {
        if (data.peripheral !== deviceId) return;
        if (data.characteristic?.toLowerCase() !== RX_UUID.toLowerCase()) return;
        // data.value = number[]
        this.handleFrame(new Uint8Array(data.value));
      }
    );
    this.listeners.push(notifListener);

    // Écouter déconnexion
    const discListener = this.emitter.addListener(
      'BleManagerDisconnectPeripheral',
      (data: any) => {
        if (data.peripheral === deviceId) {
          console.log('[BleGateway] Device déconnecté');
          this.connectedId = null;
        }
      }
    );
    this.listeners.push(discListener);

    // ── 6. DeviceQuery (cmd=22) ──
    await this.sendFrame(CMD_DEVICE_QUERY, new Uint8Array([APP_PROTOCOL_VERSION]));
    console.log('[BleGateway] DeviceQuery envoyé');
    await new Promise((res) => setTimeout(res, 400));

    // ── 7. AppStart (cmd=1) ──
    const appName = 'BitMesh\0';
    const appNameBytes = new TextEncoder().encode(appName);
    const appStartPayload = new Uint8Array(1 + 6 + appNameBytes.length);
    appStartPayload[0] = 0x01; // app version
    // bytes 1-6 : reserved (0x00)
    appStartPayload.set(appNameBytes, 7);
    await this.sendFrame(CMD_APP_START, appStartPayload);
    console.log('[BleGateway] AppStart envoyé — attente SelfInfo (code=5)...');

    // SetTime envoyé automatiquement dans parseSelfInfo après réception
    await new Promise((res) => setTimeout(res, 5000));
    console.log('[BleGateway] Handshake terminé');
  }

  // ── Bonding explicite ────────────────────────────────────────────

  /**
   * createBond() → dialogue PIN Android → BleManagerBondingComplete.
   *
   * Si le device est déjà bondé, createBond() peut :
   *   - Retourner immédiatement (déjà bondé)
   *   - Émettre BondingComplete avec status success
   *   - Throw une erreur "already bonded" → on résout quand même
   *
   * timeout: 60s pour laisser le temps d'entrer le PIN.
   */
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
        console.warn('[BleGateway] Bonding timeout (60s) — tentative de continuer...');
        done(); // Timeout → on essaie quand même
      }, timeoutMs);

      const bondListener = this.emitter.addListener(
        'BleManagerBondingComplete',
        (data: any) => {
          if (data.peripheral !== deviceId) return;
          if (data.status === 'success') {
            console.log('[BleGateway] Bonding réussi');
            done();
          } else {
            console.warn('[BleGateway] Bonding status:', data.status);
            done(new Error(`Bonding échoué : ${data.status}. Vérifiez le PIN (défaut : 123456).`));
          }
        }
      );

      console.log('[BleGateway] createBond() — entrez le PIN dans le dialogue Android...');
      BleManager.createBond(deviceId)
        .then(() => {
          // createBond() resolved → peut signifier "déjà bondé" ou "bondé maintenant"
          // On attend BleManagerBondingComplete pour confirmation, sinon timeout 3s
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
    this.listeners.forEach((l) => l.remove());
    this.listeners = [];
    if (this.connectedId) {
      console.log('[BleGateway] Déconnexion...');
      await BleManager.disconnect(this.connectedId).catch(() => {});
      this.connectedId = null;
    }
  }

  // ── Envoyer paquet BitMesh ───────────────────────────────────────

  /**
   * Envoie un paquet BitMesh encodé via CMD_SEND_RAW (0x19).
   *
   * ⚠️ FIRMWARE CUSTOM REQUIS : CMD_SEND_RAW bypasse le routing MeshCore
   * et envoie des bytes bruts sur LoRa. Cette méthode ne fonctionne qu'avec
   * le firmware BitMesh custom — elle est INCOMPATIBLE avec le firmware
   * MeshCore standard (Companion app).
   *
   * Pour le firmware MeshCore standard, utiliser plutôt :
   *   - `sendDirectMessage()` → CMD_SEND_TXT_MSG (0x02)
   *   - `sendChannelMessage()` → CMD_SEND_CHAN_MSG (0x03)
   *
   * @param packet - Paquet MeshCore à encoder et envoyer
   */
  async sendPacket(packet: MeshCorePacket): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté à un device MeshCore');

    const encoded = encodeMeshCorePacket(packet);
    const payload = new Uint8Array(1 + encoded.length);
    payload[0] = 0x00; // path_length = 0 (broadcast)
    payload.set(encoded, 1);

    console.log(`[BleGateway] sendPacket type=${packet.type} (${encoded.length}B)`);
    await this.sendFrame(CMD_SEND_RAW, payload);
  }

  /**
   * Envoie un DM texte via CMD_SEND_TXT_MSG (0x02).
   * Compatible avec le firmware MeshCore standard v1.13 (Companion protocol).
   *
   * Format exact selon MyMesh.cpp handleCmdFrame() :
   *   [cmd=2][txt_type:1][attempt:1][timestamp:4 LE][pub_key_prefix:6][text...]
   *
   * Le firmware recherche le contact par les 6 premiers bytes de sa pubkey
   * via lookupContactByPubKey(). Le destinataire doit être dans les contacts.
   *
   * @param pubkeyHex - Clé publique du destinataire (min 12 hex chars = 6 bytes)
   * @param text      - Texte en clair
   * @param attempt   - Numéro de tentative (0 = premier envoi)
   */
  async sendDirectMessage(pubkeyHex: string, text: string, attempt = 0): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté à un device MeshCore');

    // Accepter 64 chars (x-only 32B) ou 66 chars (compressée 02/03 + 32B)
    const hexClean = pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
    const pubkeyBytes = new Uint8Array(hexClean.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));
    const textBytes = new TextEncoder().encode(text);

    // Timestamp courant (uint32 LE)
    const ts = Math.floor(Date.now() / 1000);
    const tsBuf = new Uint8Array(4);
    new DataView(tsBuf.buffer).setUint32(0, ts, true);  // little-endian

    // Format firmware : [txt_type=0][attempt][timestamp:4][pub_key_prefix:6][text...]
    const payload = new Uint8Array(1 + 1 + 4 + 6 + textBytes.length);
    let i = 0;
    payload[i++] = 0;          // txt_type = TXT_TYPE_PLAIN
    payload[i++] = attempt & 0xFF;
    payload.set(tsBuf, i); i += 4;
    payload.set(pubkeyBytes.slice(0, 6), i); i += 6;
    payload.set(textBytes, i);

    console.log(`[BleGateway] sendDirectMessage → CMD_SEND_TXT_MSG prefix=${hexClean.slice(0, 12)} (${text.length}B)`);
    await this.sendFrame(CMD_SEND_TXT_MSG, payload);
  }

  /**
   * Envoie un message sur un canal via CMD_SEND_CHAN_MSG (0x03).
   * Compatible avec le firmware MeshCore standard v1.13 (Companion protocol).
   *
   * Format exact selon companion_protocol.md §Send Channel Message :
   *   [cmd=3][reserved=0][channelIdx:1][timestamp:4 LE][text...]
   *
   * @param channelIdx - Index du canal (0 = canal public par défaut)
   * @param text       - Texte du message
   */
  async sendChannelMessage(channelIdx: number, text: string): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté à un device MeshCore');

    const textBytes = new TextEncoder().encode(text);

    // Timestamp courant (uint32 LE)
    const ts = Math.floor(Date.now() / 1000);
    const tsBuf = new Uint8Array(4);
    new DataView(tsBuf.buffer).setUint32(0, ts, true);  // little-endian

    // Format firmware : [reserved=0][channelIdx][timestamp:4][text...]
    const payload = new Uint8Array(1 + 1 + 4 + textBytes.length);
    payload[0] = 0;             // reserved
    payload[1] = channelIdx & 0xFF;
    payload.set(tsBuf, 2);
    payload.set(textBytes, 6);

    console.log(`[BleGateway] sendChannelMessage ch=${channelIdx} (${text.length}B)`);
    await this.sendFrame(CMD_SEND_CHAN_MSG, payload);
  }

  // ── Handlers publics ────────────────────────────────────────────

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onDeviceInfo(cb: (info: BleDeviceInfo) => void): void {
    this.deviceInfoCallback = cb;
  }

  getDeviceInfo(): BleDeviceInfo | null {
    return this.deviceInfo;
  }

  isConnected(): boolean {
    return this.connectedId !== null;
  }

  getConnectedDevice(): BleGatewayDevice | null {
    if (!this.connectedId) return null;
    return { id: this.connectedId, name: 'MeshCore', rssi: -70 };
  }

  async destroy(): Promise<void> {
    await this.disconnect();
  }

  // ── Privé : Frame handler ───────────────────────────────────────

  private handleFrame(data: Uint8Array): void {
    if (data.length === 0) return;
    const code = data[0];
    const payload = data.slice(1);
    console.log(`[BleGateway] Frame reçu code=0x${code.toString(16)} (${payload.length}B)`);

    switch (code) {
      case RESP_SELF_INFO:
        this.parseSelfInfo(payload);
        break;
      case RESP_DEVICE_INFO:
        console.log('[BleGateway] DeviceInfo reçu');
        break;
      case RESP_OK:
        break;
      case PUSH_RAW_DATA:
        if (payload.length > RAW_PUSH_HEADER_SIZE) {
          const snr  = (payload[0] << 24 >> 24) / 4;
          const rssi = payload[1] << 24 >> 24;
          const raw  = payload.slice(RAW_PUSH_HEADER_SIZE);
          console.log(`[BleGateway] RawData SNR:${snr} RSSI:${rssi} (${raw.length}B)`);
          this.deliverRawPacket(raw);
        }
        break;
      case RESP_DIRECT_MSG:
        // PACKET_CONTACT_MSG_RECV_V3 (0x10) — firmware v1.13 companion protocol
        // Format : [SNR:1][reserved:2][pub_key_prefix:6][path_len:1][txt_type:1][timestamp:4LE][text...]
        if (payload.length > 15) {
          const snrDm = (payload[0] << 24 >> 24) / 4;
          const fromPubkeyHex = Array.from(payload.slice(3, 9))
            .map(b => b.toString(16).padStart(2, '0')).join('');
          const text = new TextDecoder().decode(payload.slice(15));
          console.log(`[BleGateway] DirectMsg SNR=${snrDm} de ${fromPubkeyHex}…: "${text.slice(0, 40)}"`);
          this.deliverCompanionTextPacket(fromPubkeyHex, text, false);
        }
        break;
      case RESP_CHANNEL_MSG:
        // PACKET_CHANNEL_MSG_RECV_V3 (0x11) — firmware v1.13 companion protocol
        // Format : [SNR:1][reserved:2][channelIdx:1][path_len:1][txt_type:1][timestamp:4LE][text...]
        if (payload.length > 10) {
          const snrCh = (payload[0] << 24 >> 24) / 4;
          const channelIdx = payload[3];
          const text = new TextDecoder().decode(payload.slice(10));
          console.log(`[BleGateway] ChannelMsg SNR=${snrCh} ch=${channelIdx}: "${text.slice(0, 40)}"`);
          this.deliverCompanionTextPacket('', text, true, channelIdx);
        }
        break;
      default:
        console.log(`[BleGateway] Code non géré 0x${code.toString(16)}`);
    }
  }

  // ── Privé : SelfInfo parser ─────────────────────────────────────

  /**
   * Layout SelfInfo (code=5) — source : meshcore-open parseSelfInfo()
   *   [0]      type       (1B)
   *   [1]      txPower    (1B)
   *   [2]      maxTxPower (1B)
   *   [3..34]  publicKey  (32B)
   *   [35..38] advLat     (int32 LE)
   *   [39..42] advLon     (int32 LE)
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

    /* type */      off++;
    const txPower = payload[off++];
    /* maxTx */     off++;

    const pubkeyBytes = payload.slice(off, off + 32); off += 32;
    const publicKey   = Array.from(pubkeyBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

    const advLatRaw = view.getInt32(off, true);  off += 4;
    const advLonRaw = view.getInt32(off, true);  off += 4;
    off += 4; // reserved+manualAddContacts

    const radioFreqHz = view.getUint32(off, true); off += 4;
    const radioBwHz   = view.getUint32(off, true); off += 4;
    const radioSf     = payload[off++];
    const radioCr     = payload[off++];

    const nameRaw = payload.slice(off);
    const name = new TextDecoder().decode(nameRaw).replace(/\0/g, '').trim() || 'MeshCore';

    const info: BleDeviceInfo = {
      name, publicKey, txPower, radioFreqHz, radioBwHz, radioSf, radioCr,
      advLat: advLatRaw / 1e7,
      advLon: advLonRaw / 1e7,
    };
    this.deviceInfo = info;
    console.log('[BleGateway] SelfInfo:', { name, freq: radioFreqHz, sf: radioSf, txPower });

    if (this.deviceInfoCallback) this.deviceInfoCallback(info);

    // SetTime (cmd=6) — obligatoire après SelfInfo
    const ts = Math.floor(Date.now() / 1000);
    const timeBuf = new Uint8Array(4);
    new DataView(timeBuf.buffer).setUint32(0, ts, true);
    this.sendFrame(CMD_SET_TIME, timeBuf)
      .then(() => console.log('[BleGateway] SetTime envoyé:', ts))
      .catch((e) => console.warn('[BleGateway] SetTime échoué:', e));
  }

  /**
   * Convertit un message texte reçu via le protocole Companion standard
   * (RESP_DIRECT_MSG / RESP_CHANNEL_MSG) en MeshCorePacket et le livre
   * au handler de l'application.
   */
  private deliverCompanionTextPacket(
    fromPubkeyHex: string,
    text: string,
    isChannel: boolean,
    channelIdx = 0
  ): void {
    if (!this.messageHandler) return;
    try {
      // Construire un MeshCorePacket synthétique depuis le message companion
      // Le fromNodeId est dérivé des 8 premiers bytes de la pubkey du sender
      // Pad pubkey prefix (6 bytes from V3) to 8 bytes for BigUint64 read
      const rawPubkeyBytes = fromPubkeyHex
        ? new Uint8Array(fromPubkeyHex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)))
        : new Uint8Array(0);
      const padded = new Uint8Array(8);
      padded.set(rawPubkeyBytes.slice(0, Math.min(rawPubkeyBytes.length, 8)));
      const fromNodeId = new DataView(padded.buffer).getBigUint64(0, false);

      const randomId = new Uint32Array(1);
      crypto.getRandomValues(randomId);
      const packet: MeshCorePacket = {
        version: 0x01,
        type: 0x01, // MeshCoreMessageType.TEXT
        flags: 0x00, // En clair (firmware a déjà déchiffré)
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

  // ── Privé : BLE write ───────────────────────────────────────────

  /**
   * Write WITH response sur 6e400002 (device RX char, PROPERTY_WRITE).
   * Le firmware n'a pas PROPERTY_WRITE_WITHOUT_RESPONSE → write sans réponse ignoré.
   */
  private async sendFrame(cmd: number, payload: Uint8Array): Promise<void> {
    if (!this.connectedId) throw new Error('Non connecté');

    const frame = new Uint8Array(1 + payload.length);
    frame[0] = cmd;
    frame.set(payload, 1);

    // Découper en chunks si nécessaire
    for (let offset = 0; offset < frame.length; offset += BLE_MAX_WRITE) {
      const chunk = Array.from(frame.slice(offset, offset + BLE_MAX_WRITE));
      await BleManager.write(
        this.connectedId,
        SERVICE_UUID,
        TX_UUID,    // 6e400002 = App → Device
        chunk,
        BLE_MAX_WRITE
      );
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let _instance: BleGatewayClient | null = null;

export function getBleGatewayClient(): BleGatewayClient {
  if (!_instance) _instance = new BleGatewayClient();
  return _instance;
}
