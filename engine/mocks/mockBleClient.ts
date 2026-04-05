/**
 * Mock BLE Gateway Client pour les tests d'intégration
 * Simule le comportement du BleGatewayClient réel
 */

import type { 
  BleGatewayClient, 
  MeshCoreIncomingMsg, 
  MeshCoreContact,
  BleDeviceInfo,
  ChannelConfig,
} from '@/utils/ble-gateway';

export interface MockBleClient {
  // Propriétés
  _isConnected: boolean;
  
  // Méthodes de connexion
  connect: jest.Mock;
  disconnect: jest.Mock;
  
  // Méthodes d'envoi
  sendDirectMessage: jest.Mock;
  sendChannelMessage: jest.Mock;
  
  // Méthodes de configuration
  syncNextMessage: jest.Mock;
  setChannel: jest.Mock;
  
  // Méthodes d'écoute
  onIncomingMessage: jest.Mock;
  onContactDiscovered: jest.Mock;
  onContacts: jest.Mock;
  onDisconnect: jest.Mock;
  onSendConfirmed: jest.Mock;
  onBattery: jest.Mock;
  onStats: jest.Mock;
  
  // Utilitaires
  getDeviceInfo: jest.Mock;
  isConnected: jest.Mock;
  getChannelConfig: jest.Mock;
  
  // Helpers pour les tests
  simulateIncomingMessage: (msg: Partial<MeshCoreIncomingMsg>) => void;
  simulateContactDiscovered: (contact: MeshCoreContact) => void;
  simulateContactsList: (contacts: MeshCoreContact[]) => void;
  simulateDisconnection: () => void;
  simulateSendConfirmed: (ackCode: number, roundTripMs: number) => void;
  simulateBattery: (volts: number) => void;
  
  // Callbacks stockées
  _incomingMessageCallbacks: Array<(msg: MeshCoreIncomingMsg) => void>;
  _contactDiscoveredCallbacks: Array<(contact: MeshCoreContact) => void>;
  _contactsCallbacks: Array<(contacts: MeshCoreContact[]) => void>;
  _disconnectCallbacks: Array<() => void>;
  _sendConfirmedCallbacks: Array<(ackCode: number, roundTripMs: number) => void>;
  _batteryCallbacks: Array<(volts: number) => void>;
  _statsCallbacks: Array<(stats: any) => void>;
  
  // État interne
  _currentChannel: number;
  _contacts: Map<string, MeshCoreContact>;
  _deviceId?: string;
  _deviceInfo: BleDeviceInfo | null;
  _channelConfigs: Map<number, ChannelConfig>;
}

export const createMockBleClient = (): MockBleClient => {
  const mockClient = {
    // État
    _isConnected: false,
    _currentChannel: 0,
    _contacts: new Map<string, MeshCoreContact>(),
    _deviceId: undefined as string | undefined,
    _deviceInfo: null as BleDeviceInfo | null,
    _channelConfigs: new Map<number, ChannelConfig>(),
    
    // Callbacks
    _incomingMessageCallbacks: [] as Array<(msg: MeshCoreIncomingMsg) => void>,
    _contactDiscoveredCallbacks: [] as Array<(contact: MeshCoreContact) => void>,
    _contactsCallbacks: [] as Array<(contacts: MeshCoreContact[]) => void>,
    _disconnectCallbacks: [] as Array<() => void>,
    _sendConfirmedCallbacks: [] as Array<(ackCode: number, roundTripMs: number) => void>,
    _batteryCallbacks: [] as Array<(volts: number) => void>,
    _statsCallbacks: [] as Array<(stats: any) => void>,
    
    // Connexion
    connect: jest.fn().mockImplementation(async (deviceId: string) => {
      mockClient._deviceId = deviceId;
      mockClient._isConnected = true;
      mockClient._deviceInfo = {
        nodeId: 'MOCK-NODE-001',
        publicKey: new Uint8Array(32),
        publicKeyHex: 'mock-pubkey-hex-32-bytes-long-string',
        name: 'Mock MeshCore Device',
        version: '1.0.0',
        features: 0xFFFF,
        radioFreq: 869.525,
        radioBw: 125,
        radioSf: 12,
        radioCr: 5,
        battVoltage: 4.2,
        freeHeap: 100000,
        nContacts: 0,
        lastRxSnr: 0,
        lastRssi: -70,
        defaultPubKey: new Uint8Array(32),
      };
      // Configurer le canal 0 par défaut
      mockClient._channelConfigs.set(0, {
        index: 0,
        name: 'Public',
        secret: new Uint8Array(16),
        configured: true,
      });
    }),
    
    disconnect: jest.fn().mockImplementation(async () => {
      mockClient._isConnected = false;
      mockClient._disconnectCallbacks.forEach(cb => {
        try { cb(); } catch {}
      });
    }),
    
    // Envoi
    sendDirectMessage: jest.fn().mockImplementation(async (pubkeyHex: string, text: string) => {
      if (!mockClient._isConnected) {
        throw new Error('Non connecté à un device MeshCore');
      }
      // Simuler confirmation d'envoi
      setTimeout(() => {
        mockClient._sendConfirmedCallbacks.forEach(cb => {
          try { cb(0, 150); } catch {}
        });
      }, 10);
    }),
    
    sendChannelMessage: jest.fn().mockImplementation(async (channelIdx: number, text: string) => {
      if (!mockClient._isConnected) {
        throw new Error('Non connecté à un device MeshCore');
      }
      mockClient._currentChannel = channelIdx;
      setTimeout(() => {
        mockClient._sendConfirmedCallbacks.forEach(cb => {
          try { cb(0, 100); } catch {}
        });
      }, 10);
    }),
    
    // Configuration
    syncNextMessage: jest.fn().mockImplementation(async () => {
      if (!mockClient._isConnected) return;
      // Simuler la synchronisation
    }),
    
    setChannel: jest.fn().mockImplementation(async (channelIdx: number) => {
      mockClient._currentChannel = channelIdx;
      // Configurer le canal s'il n'existe pas
      if (!mockClient._channelConfigs.has(channelIdx)) {
        mockClient._channelConfigs.set(channelIdx, {
          index: channelIdx,
          name: `Channel ${channelIdx}`,
          secret: new Uint8Array(16),
          configured: true,
        });
      }
    }),
    
    // Écoute - callbacks simples qui remplacent le handler précédent
    onIncomingMessage: jest.fn().mockImplementation((callback: (msg: MeshCoreIncomingMsg) => void) => {
      mockClient._incomingMessageCallbacks = [callback];
    }),
    
    onContactDiscovered: jest.fn().mockImplementation((callback: (contact: MeshCoreContact) => void) => {
      mockClient._contactDiscoveredCallbacks.push(callback);
    }),
    
    onContacts: jest.fn().mockImplementation((callback: (contacts: MeshCoreContact[]) => void) => {
      mockClient._contactsCallbacks.push(callback);
    }),
    
    onDisconnect: jest.fn().mockImplementation((callback: () => void) => {
      mockClient._disconnectCallbacks.push(callback);
    }),
    
    onSendConfirmed: jest.fn().mockImplementation((callback: (ackCode: number, roundTripMs: number) => void) => {
      mockClient._sendConfirmedCallbacks.push(callback);
    }),
    
    onBattery: jest.fn().mockImplementation((callback: (volts: number) => void) => {
      mockClient._batteryCallbacks.push(callback);
    }),
    
    onStats: jest.fn().mockImplementation((callback: (stats: any) => void) => {
      mockClient._statsCallbacks.push(callback);
    }),
    
    // Utilitaires
    getDeviceInfo: jest.fn().mockImplementation(() => mockClient._deviceInfo),
    
    isConnected: jest.fn().mockImplementation(() => mockClient._isConnected),
    
    getChannelConfig: jest.fn().mockImplementation((index: number) => {
      return mockClient._channelConfigs.get(index);
    }),
    
    // Helpers pour les tests
    simulateIncomingMessage: (msg: Partial<MeshCoreIncomingMsg>) => {
      const fullMsg: MeshCoreIncomingMsg = {
        type: msg.type || 'direct',
        senderPubkeyPrefix: msg.senderPubkeyPrefix || 'aabbccdd',
        text: msg.text || 'Hello from LoRa!',
        channelIdx: msg.channelIdx ?? mockClient._currentChannel,
        pathLen: msg.pathLen ?? 0,
        txtType: msg.txtType ?? 0,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
        snr: msg.snr,
        ...msg,
      };
      mockClient._incomingMessageCallbacks.forEach(cb => {
        try { cb(fullMsg); } catch (e) { console.error('Error in incoming message callback:', e); }
      });
    },
    
    simulateContactDiscovered: (contact: MeshCoreContact) => {
      mockClient._contacts.set(contact.pubkeyHex, contact);
      mockClient._contactDiscoveredCallbacks.forEach(cb => {
        try { cb(contact); } catch {}
      });
    },
    
    simulateContactsList: (contacts: MeshCoreContact[]) => {
      contacts.forEach(c => mockClient._contacts.set(c.pubkeyHex, c));
      mockClient._contactsCallbacks.forEach(cb => {
        try { cb(contacts); } catch {}
      });
    },
    
    simulateDisconnection: () => {
      mockClient._isConnected = false;
      mockClient._disconnectCallbacks.forEach(cb => {
        try { cb(); } catch {}
      });
    },
    
    simulateSendConfirmed: (ackCode: number, roundTripMs: number) => {
      mockClient._sendConfirmedCallbacks.forEach(cb => {
        try { cb(ackCode, roundTripMs); } catch {}
      });
    },
    
    simulateBattery: (volts: number) => {
      mockClient._batteryCallbacks.forEach(cb => {
        try { cb(volts); } catch {}
      });
    },
  };
  
  return mockClient as MockBleClient;
};

/**
 * Crée un mock de contact MeshCore compatible avec l'interface réelle
 */
export const createMockContact = (overrides?: Partial<MeshCoreContact>): MeshCoreContact => ({
  publicKey: new Uint8Array(32).fill(0xAB),
  pubkeyHex: overrides?.pubkeyHex || `pubkey${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  pubkeyPrefix: overrides?.pubkeyPrefix || 'aabbccdd',
  name: overrides?.name || 'Mock Contact',
  lastSeen: overrides?.lastSeen || Date.now(),
  lat: overrides?.lat,
  lng: overrides?.lng,
  ...overrides,
});

/**
 * Crée plusieurs contacts mock
 */
export const createMockContacts = (count: number): MeshCoreContact[] => {
  return Array.from({ length: count }, (_, i) => createMockContact({
    name: `Contact ${i + 1}`,
    pubkeyHex: `pubkey${i + 1}hex${'a'.repeat(20)}`,
    pubkeyPrefix: `prefix${i + 1}`,
  }));
};

/**
 * Crée un mock de message entrant MeshCore
 */
export const createMockIncomingMessage = (
  type: 'direct' | 'channel' = 'direct',
  overrides?: Partial<MeshCoreIncomingMsg>
): MeshCoreIncomingMsg => ({
  type,
  senderPubkeyPrefix: overrides?.senderPubkeyPrefix || 'sender-prefix',
  text: overrides?.text || 'Test message',
  channelIdx: overrides?.channelIdx ?? 0,
  pathLen: overrides?.pathLen ?? 0,
  txtType: overrides?.txtType ?? 0,
  timestamp: overrides?.timestamp || Math.floor(Date.now() / 1000),
  snr: overrides?.snr,
  ...overrides,
});

export default createMockBleClient;
