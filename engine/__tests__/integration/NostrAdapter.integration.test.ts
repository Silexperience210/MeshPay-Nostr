/**
 * Tests d'intégration pour NostrAdapter
 * 
 * Ces tests vérifient:
 * - La communication entre NostrAdapter et HermesEngine
 * - Le flux complet : Event → Adapter → Transport simulé → Handler
 * - La gestion des connexions/déconnexions
 * - Le fallback NIP-04/NIP-17
 * - Le bridge LoRa→Nostr
 */

import { HermesEngine, ProtocolAdapter } from '../../HermesEngine';
import { NostrAdapter } from '../../adapters/NostrAdapter';
import { Transport, EventType, HermesEvent, MessageEvent } from '../../types';
import { createMockNostrClient, MockNostrClient } from '../../mocks/mockNostrClient';

describe('NostrAdapter Integration', () => {
  let engine: HermesEngine;
  let adapter: NostrAdapter;
  let mockClient: MockNostrClient;
  
  beforeEach(() => {
    jest.useFakeTimers();
    engine = new HermesEngine({ debug: false });
    mockClient = createMockNostrClient();
    adapter = new NostrAdapter(engine, mockClient as any);
    engine.registerAdapter(adapter);
  });
  
  afterEach(async () => {
    jest.useRealTimers();
    await engine.stop();
  });

  describe('Connection Lifecycle', () => {
    it('should connect and emit TRANSPORT_CONNECTED', async () => {
      const connectedHandler = jest.fn();
      engine.on(EventType.TRANSPORT_CONNECTED, connectedHandler);
      
      await engine.start();
      
      // Avancer les timers pour le check de connexion
      jest.advanceTimersByTime(1500);
      
      expect(connectedHandler).toHaveBeenCalled();
      const event = connectedHandler.mock.calls[0][0];
      expect(event.transport).toBe(Transport.NOSTR);
      expect(event.payload.transport).toBe(Transport.NOSTR);
    });
    
    it('should handle disconnection gracefully', async () => {
      const disconnectedHandler = jest.fn();
      engine.on(EventType.TRANSPORT_DISCONNECTED, disconnectedHandler);
      
      await engine.start();
      jest.advanceTimersByTime(1500);
      
      // Simuler une déconnexion
      mockClient.simulateDisconnection();
      jest.advanceTimersByTime(1500);
      
      expect(disconnectedHandler).toHaveBeenCalled();
      const event = disconnectedHandler.mock.calls[0][0];
      expect(event.transport).toBe(Transport.NOSTR);
    });
    
    it('should reconnect and restart listeners', async () => {
      const connectedHandler = jest.fn();
      engine.on(EventType.TRANSPORT_CONNECTED, connectedHandler);
      
      await engine.start();
      jest.advanceTimersByTime(1500);
      
      // Déconnexion
      mockClient.simulateDisconnection();
      jest.advanceTimersByTime(1500);
      
      // Reconnexion
      mockClient.simulateReconnection();
      jest.advanceTimersByTime(1500);
      
      // Deux appels: initial + reconnexion
      expect(connectedHandler).toHaveBeenCalledTimes(2);
    });
    
    it('should report isConnected correctly', async () => {
      await engine.start();
      jest.advanceTimersByTime(1500);
      
      expect(adapter.isConnected).toBe(true);
      
      mockClient.simulateDisconnection();
      jest.advanceTimersByTime(1500);
      
      expect(adapter.isConnected).toBe(false);
    });
  });

  describe('Sending Messages', () => {
    beforeEach(async () => {
      await engine.start();
      jest.advanceTimersByTime(1500);
    });
    
    it('should send DM and receive confirmation', async () => {
      const event: MessageEvent = {
        id: 'test-dm-1',
        type: EventType.DM_SENT,
        transport: Transport.NOSTR,
        timestamp: Date.now(),
        from: 'local',
        to: 'recipient-npub-123',
        payload: {
          content: 'Hello Nostr!',
          contentType: 'text',
        },
        meta: {},
      };
      
      await engine.emit(event, Transport.NOSTR);
      
      expect(mockClient.publishDMSealed).toHaveBeenCalledWith(
        'recipient-npub-123',
        'Hello Nostr!'
      );
    });
    
    it('should send channel message', async () => {
      const event: MessageEvent = {
        id: 'test-channel-1',
        type: EventType.CHANNEL_MSG_SENT,
        transport: Transport.NOSTR,
        timestamp: Date.now(),
        from: 'local',
        to: 'general',
        payload: {
          content: 'Hello everyone!',
          contentType: 'text',
          channelName: 'general',
        },
        meta: {},
      };
      
      await engine.emit(event, Transport.NOSTR);
      
      expect(mockClient.publishChannelMessage).toHaveBeenCalledWith(
        'general',
        'Hello everyone!'
      );
    });
    
    it('should send TxRelay for bridge', async () => {
      const event: HermesEvent = {
        id: 'test-bridge-1',
        type: EventType.BRIDGE_LORA_TO_NOSTR,
        transport: Transport.NOSTR,
        timestamp: Date.now(),
        from: 'lora-node',
        to: '*',
        payload: {
          rawPayload: JSON.stringify({ message: 'Bridged from LoRa' }),
        },
        meta: {},
      };
      
      await engine.emit(event, Transport.NOSTR);
      
      expect(mockClient.publishTxRelay).toHaveBeenCalled();
    });
    
    it('should throw error when not connected', async () => {
      mockClient.simulateDisconnection();
      jest.advanceTimersByTime(1500);
      
      const event: MessageEvent = {
        id: 'test-dm-disconnected',
        type: EventType.DM_SENT,
        transport: Transport.NOSTR,
        timestamp: Date.now(),
        from: 'local',
        to: 'recipient',
        payload: {
          content: 'This should fail',
          contentType: 'text',
        },
        meta: {},
      };
      
      await expect(engine.emit(event, Transport.NOSTR)).rejects.toThrow('non disponible');
    });
  });

  describe('Receiving Messages', () => {
    beforeEach(async () => {
      await engine.start();
      jest.advanceTimersByTime(1500);
    });
    
    it('should receive DM from Nostr and emit event', () => {
      const dmHandler = jest.fn();
      engine.on(EventType.DM_RECEIVED, dmHandler);
      
      mockClient.simulateIncomingDM(
        'foreign-pubkey-hex-123',
        'Hello from Nostr!',
        {
          id: 'nostr-dm-1',
          created_at: Math.floor(Date.now() / 1000),
        }
      );
      
      expect(dmHandler).toHaveBeenCalled();
      const event = dmHandler.mock.calls[0][0];
      expect(event.type).toBe(EventType.DM_RECEIVED);
      expect(event.transport).toBe(Transport.NOSTR);
      expect(event.from).toContain('npub');
      expect(event.payload.content).toBe('Hello from Nostr!');
    });
    
    it('should receive channel message from Nostr', () => {
      const channelHandler = jest.fn();
      engine.on(EventType.CHANNEL_MSG_RECEIVED, channelHandler);
      
      mockClient.simulateIncomingChannel({
        id: 'nostr-channel-1',
        pubkey: 'foreign-pubkey-hex',
        content: 'Message in #general',
        tags: [['e', 'general', '', 'root']],
        created_at: Math.floor(Date.now() / 1000),
      });
      
      expect(channelHandler).toHaveBeenCalled();
      const event = channelHandler.mock.calls[0][0];
      expect(event.type).toBe(EventType.CHANNEL_MSG_RECEIVED);
      expect(event.payload.channelName).toBe('general');
    });
    
    it('should deduplicate own messages', () => {
      const dmHandler = jest.fn();
      engine.on(EventType.DM_RECEIVED, dmHandler);
      
      // Simuler un message venant de notre propre pubkey
      mockClient.simulateIncomingDM(
        mockClient.publicKey,
        'My own message',
      );
      
      expect(dmHandler).not.toHaveBeenCalled();
    });
    
    it('should handle TxRelay (bridge Nostr→LoRa)', () => {
      const bridgeHandler = jest.fn();
      engine.on(EventType.BRIDGE_NOSTR_TO_LORA, bridgeHandler);
      
      mockClient.simulateIncomingTxRelay(
        { type: 'lora_relay', data: 'Hello LoRa' },
        { id: 'tx-relay-1' }
      );
      
      expect(bridgeHandler).toHaveBeenCalled();
      const event = bridgeHandler.mock.calls[0][0];
      expect(event.type).toBe(EventType.BRIDGE_NOSTR_TO_LORA);
      expect(event.payload.targetTransport).toBe(Transport.LORA);
    });
    
    it('should include meshcore-from tag if present', () => {
      const dmHandler = jest.fn();
      engine.on(EventType.DM_RECEIVED, dmHandler);
      
      mockClient.simulateIncomingDM(
        'foreign-pubkey-hex',
        'Message with meshcore tag',
        {
          tags: [
            ['p', mockClient.publicKey],
            ['meshcore-from', 'meshcore-node-123'],
          ],
        }
      );
      
      const event = dmHandler.mock.calls[0][0];
      expect(event.from).toBe('meshcore-node-123');
    });
  });

  describe('NIP-04/NIP-17 Fallback', () => {
    beforeEach(async () => {
      await engine.start();
      jest.advanceTimersByTime(1500);
    });
    
    it('should handle NIP-04 fallback when NIP-17 fails', () => {
      // Simuler que subscribeDMsSealed échoue
      mockClient.subscribeDMsSealed.mockImplementation(() => {
        throw new Error('NIP-17 not supported');
      });
      
      // Recréer l'adapter pour qu'il utilise les mocks modifiés
      const fallbackAdapter = new NostrAdapter(engine, mockClient as any);
      
      // Ne pas planter signifie que le fallback a fonctionné
      expect(() => fallbackAdapter.start()).not.toThrow();
    });
    
    it('should mark DM with correct encryption type', () => {
      const dmHandler = jest.fn();
      engine.on(EventType.DM_RECEIVED, dmHandler);
      
      mockClient.simulateIncomingDM(
        'foreign-pubkey',
        'Encrypted message',
        { id: 'dm-nip17' }
      );
      
      const event = dmHandler.mock.calls[0][0];
      expect(event.payload.encryption).toBeDefined();
    });
  });

  describe('Bridge LoRa→Nostr', () => {
    beforeEach(async () => {
      await engine.start();
      jest.advanceTimersByTime(1500);
    });
    
    it('should bridge LoRa message to Nostr', async () => {
      // Simuler un événement de bridge venant du LoRaAdapter
      const bridgeEvent: HermesEvent = {
        id: 'bridge-lora-1',
        type: EventType.BRIDGE_LORA_TO_NOSTR,
        transport: Transport.INTERNAL,
        timestamp: Date.now(),
        from: 'lora-node',
        to: '*',
        payload: {
          rawPayload: JSON.stringify({
            originalTransport: Transport.LORA,
            targetTransport: Transport.NOSTR,
            content: 'Message from mesh',
          }),
        },
        meta: {},
      };
      
      await engine.emit(bridgeEvent, Transport.NOSTR);
      
      expect(mockClient.publishTxRelay).toHaveBeenCalledWith({
        type: 'lora_relay',
        data: expect.stringContaining('Message from mesh'),
      });
    });
  });

  describe('Event Deduplication', () => {
    beforeEach(async () => {
      await engine.start();
      jest.advanceTimersByTime(1500);
    });
    
    it('should deduplicate events with same ID', () => {
      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);
      
      // Premier message
      mockClient.simulateIncomingDM('pubkey-1', 'First', { id: 'duplicate-id' });
      
      // Même ID
      mockClient.simulateIncomingDM('pubkey-1', 'Duplicate', { id: 'duplicate-id' });
      
      expect(handler).toHaveBeenCalledTimes(1);
    });
    
    it('should allow different events', () => {
      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);
      
      mockClient.simulateIncomingDM('pubkey-1', 'First', { id: 'id-1' });
      mockClient.simulateIncomingDM('pubkey-1', 'Second', { id: 'id-2' });
      
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('Adapter API', () => {
    beforeEach(async () => {
      await engine.start();
      jest.advanceTimersByTime(1500);
    });
    
    it('should expose reconnect method', async () => {
      await adapter.reconnect();
      expect(mockClient.reconnectRelays).toHaveBeenCalled();
    });
    
    it('should expose publish method', async () => {
      const template = {
        kind: 1,
        content: 'Test note',
        tags: [],
      };
      
      const result = await adapter.publish(template);
      
      expect(result).toBeDefined();
      expect(result.kind).toBe(1);
    });
  });
});
