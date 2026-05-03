/**
 * MeshCore USB Adapter pour React Native
 * 
 * Adapte react-native-usb-serialport-for-android à meshcore.js
 */

import { UsbSerialManager, type UsbSerial } from 'react-native-usb-serialport-for-android';

export interface MeshCoreUsbDevice {
  id: number;
  name: string;
  vendorId: number;
  productId: number;
}

export interface MeshCoreAdapter {
  write: (data: Uint8Array) => Promise<void>;
  onData: (callback: (data: Uint8Array) => void) => void;
  close: () => Promise<void>;
}

/**
 * Liste les devices USB disponibles
 */
export async function listMeshCoreDevices(): Promise<MeshCoreUsbDevice[]> {
  const devices = await UsbSerialManager.list();
  return devices.map((d: any) => ({
    id: d.deviceId,
    name: d.deviceName || `USB Device ${d.deviceId}`,
    vendorId: d.vendorId,
    productId: d.productId,
  }));
}

/**
 * Crée un adapter meshcore.js compatible
 */
export async function createMeshCoreAdapter(deviceId: number): Promise<MeshCoreAdapter> {
  // Ouvrir le port série avec les paramètres par défaut MeshCore (115200 8N1)
  const serial: UsbSerial = await UsbSerialManager.open(deviceId, {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 0, // Parity.None
  });
  
  // Buffer pour accumuler les données reçues
  let dataCallback: ((data: Uint8Array) => void) | null = null;
  
  // Configurer le listener de données
  serial.onReceived((event: any) => {
    if (dataCallback) {
      // event.data est une chaîne hexadécimale (format de react-native-usb-serialport-for-android)
      const hexStr = event.data as string;
      const bytes = new Uint8Array(hexStr.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)));
      dataCallback(bytes);
    }
  });
  
  return {
    write: async (data: Uint8Array) => {
      // Convertir Uint8Array en chaîne hexadécimale (format attendu par react-native-usb-serialport-for-android)
      const hexStr = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('');
      await serial.send(hexStr);
    },

    onData: (callback: (data: Uint8Array) => void) => {
      dataCallback = callback;
    },

    close: async () => {
      dataCallback = null;
      await serial.close();
    },
  };
}

/**
 * Parser un paquet MeshCore reçu en binaire
 */
export async function parseMeshCorePacket(data: Uint8Array): Promise<{
  valid: boolean;
  type?: string;
  payload?: any;
  raw?: Uint8Array;
}> {
  // Vérifier la taille minimum
  if (data.length < 4) {
    return { valid: false };
  }
  
  // Header MeshCore
  const version = data[0];
  const type = data[1];
  const flags = data[2];
  const ttl = data[3];
  
  // Vérifier version
  if (version !== 0x01) {
    return { valid: false };
  }
  
  // Parser selon le type
  switch (type) {
    case 0x01: // TEXT
      return await parseTextPacket(data, flags);
    case 0x02: // POSITION
      return parsePositionPacket(data);
    case 0x03: // KEY_ANNOUNCE
      return parseKeyAnnouncePacket(data);
    case 0x04: // ACK
      return parseAckPacket(data);
    default:
      return { valid: true, type: 'UNKNOWN', raw: data };
  }
}

async function parseTextPacket(data: Uint8Array, flags: number): Promise<{
  valid: boolean;
  type: string;
  payload: any;
}> {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 4; // Skip header
    
    // Message ID (4 bytes)
    const messageId = view.getUint32(offset, false);
    offset += 4;
    
    // From Node ID (8 bytes)
    const fromNodeIdHigh = view.getBigUint64(offset, false);
    offset += 8;
    
    // To Node ID (8 bytes)
    const toNodeIdHigh = view.getBigUint64(offset, false);
    offset += 8;
    
    // Timestamp (4 bytes)
    const timestamp = view.getUint32(offset, false);
    offset += 4;
    
    // Sub-mesh ID (2 bytes)
    const subMeshId = view.getUint16(offset, false);
    offset += 2;
    
    // Payload length (2 bytes)
    const payloadLen = view.getUint16(offset, false);
    offset += 2;
    
    // Payload
    const payload = data.slice(offset, offset + payloadLen);
    
    // Décompresser si nécessaire
    let text: string;
    if (flags & 0x02) { // COMPRESSED flag
      // ✅ Décompression LZW implémentée
      try {
        const { lzwDecompress } = await import('./lzw');
        const compressed = new TextDecoder().decode(payload);
        text = lzwDecompress(compressed);
      } catch (err) {
        console.error('[MeshCore-USB] LZW decompression failed:', err);
        text = '[Decompression failed]';
      }
    } else {
      text = new TextDecoder().decode(payload);
    }
    
    return {
      valid: true,
      type: 'TEXT',
      payload: {
        messageId,
        fromNodeId: fromNodeIdHigh.toString(16).toUpperCase(),
        toNodeId: toNodeIdHigh.toString(16).toUpperCase(),
        timestamp: new Date(timestamp * 1000),
        subMeshId,
        text,
      },
    };
  } catch (err) {
    return { valid: false, type: 'TEXT', payload: { error: String(err) } };
  }
}

function parsePositionPacket(data: Uint8Array): {
  valid: boolean;
  type: string;
  payload: any;
} {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 4;
    
    // Skip header fields
    offset += 4 + 8 + 8 + 4 + 2 + 2; // messageId + from + to + timestamp + submesh + payloadLen
    
    // Payload: lat (4), lon (4), alt (2)
    const lat = view.getInt32(offset, false) / 1000000;
    offset += 4;
    const lon = view.getInt32(offset, false) / 1000000;
    offset += 4;
    const alt = view.getInt16(offset, false);
    
    return {
      valid: true,
      type: 'POSITION',
      payload: { lat, lon, alt },
    };
  } catch (err) {
    return { valid: false, type: 'POSITION', payload: { error: String(err) } };
  }
}

function parseKeyAnnouncePacket(data: Uint8Array): {
  valid: boolean;
  type: string;
  payload: any;
} {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 4;
    
    // Skip header
    offset += 4 + 8 + 8 + 4 + 2 + 2;
    
    // Payload: public key
    const payloadLen = data.length - offset - 2; // -2 pour CRC
    const pubkey = data.slice(offset, offset + payloadLen);
    
    return {
      valid: true,
      type: 'KEY_ANNOUNCE',
      payload: {
        publicKey: Array.from(pubkey).map(b => b.toString(16).padStart(2, '0')).join(''),
      },
    };
  } catch (err) {
    return { valid: false, type: 'KEY_ANNOUNCE', payload: { error: String(err) } };
  }
}

function parseAckPacket(data: Uint8Array): {
  valid: boolean;
  type: string;
  payload: any;
} {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 4;
    
    // Ack contient juste le messageId
    const messageId = view.getUint32(offset, false);
    
    return {
      valid: true,
      type: 'ACK',
      payload: { messageId },
    };
  } catch (err) {
    return { valid: false, type: 'ACK', payload: { error: String(err) } };
  }
}
