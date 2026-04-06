/**
 * Tests d'intégration pour LoRaAdapter
 * 
 * Ces tests vérifient:
 * - La connexion BLE au gateway MeshCore
 * - Le flux complet : Event → Adapter → BLE simulé → Handler
 * - La gestion des contacts MeshCore
 * - Le chunking de messages
 * - Le bridge automatique vers Nostr
 * - La gestion des déconnexions
 */

import { HermesEngine } from '../../HermesEngine';
import { LoRaAdapter } from '../../adapters/LoRaAdapter';
import { Transport, EventType, MessageEvent, BridgeEvent } from '../../types';
import { 
  createMockBleClient, 
  createMockContact, 
  createMockContacts,
  createMockIncomingMessage,
  MockBleClient 
} from '../../mocks/mockBleClient';

describe('LoRaAdapter Integration', () => {
  let engine: HermesEngine;
  let adapter: LoRaAdapter;
  let mockBle: MockBleClient;
  const TEST_DEVICE_ID = 'test-ble-device-001';
  
  beforeEach(() => {
    engine = new HermesEngine({ debug: false });
    mockBle = createMockBleClient();
    adapter = new LoRaAdapter(engine, mockBle as any, { autoBridgeToNostr: true });
    engine.registerAdapter(adapter);
  });
  
  afterEach(async () => {
    await engine.stop();
  });

  describe('Connection Lifecycle', () => {
    it('should connect to BLE gateway', async () => {
      await adapter.connect(TEST_DEVICE_ID);
      
      expect(mockBle.connect).toHaveBeenCalledWith(TEST_DEVICE_ID);
      expect(adapter.isConnected).toBe(true);
    });
    
    it('should emit TRANSPORT_CONNECTED on connect', async () => {
      const connectedHandler = jest.fn();
      engine.on(EventType.TRANSPORT_CONNECTED, connectedHandler);
      
      await engine.start();
      await adapter.connect(TEST_DEVICE_ID);
      
      expect(connectedHandler).toHaveBeenCalled();
      const event = connectedHandler.mock.calls[0][0];
      expect(event.transport).toBe(Transport.LORA);
      expect(event.payload.endpoint).toBe(TEST_DEVICE_ID);
    });
    
    it('should handle disconnection gracefully', async () => {
      const disconnectedHandler = jest.fn();
      engine.on(EventType.TRANSPORT_DISCONNECTED, disconnectedHandler);
      
      await engine.start();
      await adapter.connect(TEST_DEVICE_ID);
      
      await adapter.disconnect();
      
      expect(disconnectedHandler).toHaveBeenCalled();
      expect(adapter.isConnected).toBe(false);
    });
    
    it('should emit disconnection event when BLE disconnects unexpectedly', async () => {
      const disconnectedHandler = jest.fn();
      engine.on(EventType.TRANSPORT_DISCONNECTED, disconnectedHandler);
      
      await engine.start();
      await adapter.connect(TEST_DEVICE_ID);
      
      mockBle.simulateDisconnection();
      
      expect(disconnectedHandler).toHaveBeenCalled();
    });
  });

  describe('Sending Messages', () => {
    beforeEach(async () => {
      await engine.start();
      await adapter.connect(TEST_DEVICE_ID);
      
      // Ajouter un contact pour pouvoir envoyer des DMs
      const contact = createMockContact({
        pubkeyHex: 'recipientpubkeyhex' + 'a'.repeat(20),
        pubkeyPrefix: 'recipient',
        name: 'Test Recipient',
      });
      mockBle.simulateContactDiscovered(contact);
    });
    
    it('should send DM via LoRa', async () => {
      const event: MessageEvent = {
        id: 'test-lora-dm-1',
        type: EventType.DM_SENT,
        transport: Transport.LORA,
        timestamp: Date.now(),
        from: 'local',
        to: 'recipientpubkeyhex' + 'a'.repeat(20),
        payload: {
          content: 'Hello via LoRa!',
          contentType: 'text',
        },
        meta: {},
      };
      
      await engine.emit(event, Transport.LORA);
      
      expect(mockBle.sendDirectMessage).toHaveBeenCalledWith(
        'recipientpubkeyhex' + 'a'.repeat(20),
        'Hello via LoRa!'
      );
    });
    
    it('should throw error when contact not found', async () => {
      const event: MessageEvent = {
        id: 'test-lora-dm-unknown',
        type: EventType.DM_SENT,
        transport: Transport.LORA,
        timestamp: Date.now(),
        from: 'local',
        to: 'unknown-pubkey',
        payload: {
          content: 'To unknown contact',
          contentType: 'text',
        },
        meta: {},
      };
      
      await expect(engine.emit(event, Transport.LORA)).rejects.toThrow();
    });
    
    it('should send channel message via LoRa', async () => {
      const event: MessageEvent = {
        id: 'test-lora-channel-1',
        type: EventType.CHANNEL_MSG_SENT,
        transport: Transport.LORA,
        timestamp: Date.now(),
        from: 'local',
        to: 'broadcast',
        payload: {
          content: 'Hello channel!',
          contentType: 'text',
          channelName: 'channel-0',
        },
        meta: {},
      };
      
      await engine.emit(event, Transport.LORA);
      
      expect(mockBle.sendChannelMessage).toHaveBeenCalledWith(0, 'Hello channel!');
    });
    
    it('should use correct channel index from payload', async () => {
      const event: MessageEvent = {
        id: 'test-lora-channel-5',
        type: EventType.CHANNEL_MSG_SENT,
        transport: Transport.LORA,
        timestamp: Date.now(),
        from: 'local',
        to: 'broadcast',
        payload: {
          content: 'Message on channel 5',
          contentType: 'text',
          channelName: 'channel-5',
        },
        meta: {},
      };
      
      await engine.emit(event, Transport.LORA);
      
      expect(mockBle.sendChannelMessage).toHaveBeenCalledWith(5, 'Message on channel 5');
    });
    
    it('should throw error when not connected', async () => {
      await adapter.disconnect();
      
      const event: MessageEvent = {
        id: 'test-lora-disconnected',
        type: EventType.DM_SENT,
        transport: Transport.LORA,
        timestamp: Date.now(),
        from: 'local',
        to: 'recipientpubkeyhex' + 'a'.repeat(20),
        payload: {
          content: 'Should fail',
          contentType: 'text',
        },
        meta: {},
      };
      
      await expect(engine.emit(event, Transport.LORA)).rejects.toThrow();
    });
  });

  describe('Receiving Messages', () => {
    beforeEach(async () => {
      await engine.start();
      await adapter.connect(TEST_DEVICE_ID);
    });
    
    it('should receive DM from LoRa and emit event', () => {
      const dmHandler = jest.fn();
      engine.on(EventType.DM_RECEIVED, dmHandler);
      
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'sender-prefix',
        text: 'Hello from LoRa mesh!',
      });
      
      expect(dmHandler).toHaveBeenCalled();
      const event = dmHandler.mock.calls[0][0];
      expect(event.type).toBe(EventType.DM_RECEIVED);
      expect(event.transport).toBe(Transport.LORA);
      expect(event.payload.content).toBe('Hello from LoRa mesh!');
    });
    
    it('should receive channel message from LoRa', () => {
      const channelHandler = jest.fn();
      engine.on(EventType.CHANNEL_MSG_RECEIVED, channelHandler);
      
      mockBle.simulateIncomingMessage({
        type: 'channel',
        senderPubkeyPrefix: 'broadcaster',
        text: 'Channel broadcast',
        channelIdx: 5,
      });
      
      expect(channelHandler).toHaveBeenCalled();
      const event = channelHandler.mock.calls[0][0];
      expect(event.type).toBe(EventType.CHANNEL_MSG_RECEIVED);
      expect(event.payload.channelName).toBe('channel-5');
    });
    
    it('should include SNR in metadata', () => {
      const dmHandler = jest.fn();
      engine.on(EventType.DM_RECEIVED, dmHandler);
      
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'sender-prefix',
        text: 'With metadata',
        snr: 12.5,
        pathLen: 3,
      });
      
      const event = dmHandler.mock.calls[0][0];
      expect(event.meta.snr).toBe(12.5);
    });
  });

  describe('Auto-bridge to Nostr', () => {
    beforeEach(async () => {
      await engine.start();
      await adapter.connect(TEST_DEVICE_ID);
    });
    
    it('should auto-bridge LoRa DM to Nostr when enabled', () => {
      const bridgeHandler = jest.fn();
      engine.on(EventType.BRIDGE_LORA_TO_NOSTR, bridgeHandler);
      
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'remote-node',
        text: 'Bridge me to Nostr!',
      });
      
      expect(bridgeHandler).toHaveBeenCalled();
      const event = bridgeHandler.mock.calls[0][0];
      expect(event.type).toBe(EventType.BRIDGE_LORA_TO_NOSTR);
      expect(event.payload.originalTransport).toBe(Transport.LORA);
      expect(event.payload.targetTransport).toBe(Transport.NOSTR);
    });
    
    it('should auto-bridge LoRa channel message to Nostr', () => {
      const bridgeHandler = jest.fn();
      engine.on(EventType.BRIDGE_LORA_TO_NOSTR, bridgeHandler);
      
      mockBle.simulateIncomingMessage({
        type: 'channel',
        senderPubkeyPrefix: 'broadcaster',
        text: 'Channel to bridge',
        channelIdx: 0,
      });
      
      expect(bridgeHandler).toHaveBeenCalled();
    });
    
    it('should not bridge when autoBridgeToNostr is disabled', async () => {
      // Recréer l'adapter sans bridge
      await engine.stop();
      engine = new HermesEngine({ debug: false });
      mockBle = createMockBleClient();
      adapter = new LoRaAdapter(engine, mockBle as any, { autoBridgeToNostr: false });
      engine.registerAdapter(adapter);
      
      const bridgeHandler = jest.fn();
      engine.on(EventType.BRIDGE_LORA_TO_NOSTR, bridgeHandler);
      
      await engine.start();
      await adapter.connect(TEST_DEVICE_ID);
      
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'remote',
        text: 'Should not be bridged',
      });
      
      expect(bridgeHandler).not.toHaveBeenCalled();
    });
  });

  describe('Contact Management', () => {
    beforeEach(async () => {
      await engine.start();
      await adapter.connect(TEST_DEVICE_ID);
    });
    
    it('should update contacts on contact discovered', () => {
      const contact = createMockContact({
        pubkeyHex: 'discoveredpubkeyhex' + 'b'.repeat(20),
        pubkeyPrefix: 'discovered',
        name: 'Discovered Node',
      });
      
      mockBle.simulateContactDiscovered(contact);
      
      const contacts = adapter.getContacts();
      expect(contacts).toHaveLength(1);
      expect(contacts[0].pubkeyHex).toBe('discoveredpubkeyhex' + 'b'.repeat(20));
    });
    
    it('should update contacts on contacts list', () => {
      const contacts = createMockContacts(3);
      
      mockBle.simulateContactsList(contacts);
      
      expect(adapter.getContacts()).toHaveLength(3);
    });
    
    it('should sync contacts', async () => {
      await adapter.syncContacts();
      
      expect(mockBle.syncNextMessage).toHaveBeenCalled();
    });
  });

  describe('Content Type Detection', () => {
    beforeEach(async () => {
      await engine.start();
      await adapter.connect(TEST_DEVICE_ID);
    });
    
    it('should detect cashu token', () => {
      const dmHandler = jest.fn();
      engine.on(EventType.DM_RECEIVED, dmHandler);
      
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'sender',
        text: 'cashuAeyJ...',
      });
      
      const event = dmHandler.mock.calls[0][0];
      expect(event.payload.contentType).toBe('cashu');
    });
    
    it('should detect JSON content', () => {
      const dmHandler = jest.fn();
      engine.on(EventType.DM_RECEIVED, dmHandler);
      
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'sender',
        text: '{"type":"invoice","amount":1000}',
      });
      
      const event = dmHandler.mock.calls[0][0];
      expect(event.payload.contentType).toBe('invoice');
    });
    
    it('should default to text content type', () => {
      const dmHandler = jest.fn();
      engine.on(EventType.DM_RECEIVED, dmHandler);
      
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'sender',
        text: 'Plain text message',
      });
      
      const event = dmHandler.mock.calls[0][0];
      expect(event.payload.contentType).toBe('text');
    });
  });

  describe('Adapter API', () => {
    beforeEach(async () => {
      await engine.start();
      await adapter.connect(TEST_DEVICE_ID);
    });
    
    it('should set channel', async () => {
      await adapter.setChannel(5, 'test-channel', new Uint8Array(16));

      expect(mockBle.setChannel).toHaveBeenCalledWith(5, 'test-channel', expect.any(Uint8Array));
    });
    
    it('should get device info', () => {
      const info = adapter.getDeviceInfo();
      
      expect(info).toBeDefined();
      expect((info as any)?.nodeId).toBe('MOCK-NODE-001');
    });
  });

  describe('Auto-connect', () => {
    it('should auto-connect on start if configured', async () => {
      engine = new HermesEngine({ debug: false });
      mockBle = createMockBleClient();
      adapter = new LoRaAdapter(engine, mockBle as any, {
        autoConnect: true,
        lastDeviceId: TEST_DEVICE_ID,
        autoBridgeToNostr: false,
      });
      engine.registerAdapter(adapter);
      
      await engine.start();
      
      expect(mockBle.connect).toHaveBeenCalledWith(TEST_DEVICE_ID);
    });
    
    it('should handle auto-connect failure gracefully', async () => {
      mockBle.connect.mockRejectedValue(new Error('Device not found'));
      
      engine = new HermesEngine({ debug: false });
      adapter = new LoRaAdapter(engine, mockBle as any, {
        autoConnect: true,
        lastDeviceId: 'invalid-device',
        autoBridgeToNostr: false,
      });
      engine.registerAdapter(adapter);
      
      // Ne devrait pas planter
      await expect(engine.start()).resolves.not.toThrow();
    });
  });
});
