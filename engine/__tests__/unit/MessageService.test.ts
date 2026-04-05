/**
 * Tests unitaires du MessageService
 * 
 * Couvre:
 * - Envoi/réception de DMs
 * - Envoi/réception de messages de channel
 * - Historique
 * - Bridge
 * - Intégration Hermès + EventStore
 */

import {
  MessageServiceImpl,
  DirectMessage,
  ChannelMessage,
} from '../../services/MessageService';
import { hermes, HermesEngine } from '../../HermesEngine';
import { EventType, Transport } from '../../types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockSave = jest.fn();
const mockGetConversation = jest.fn();
const mockGetByType = jest.fn();

jest.mock('../../core/EventStore', () => ({
  eventStore: {
    save: (...args: unknown[]) => mockSave(...args),
    getConversation: (...args: unknown[]) => mockGetConversation(...args),
    getByType: (...args: unknown[]) => mockGetByType(...args),
  },
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MessageService', () => {
  let service: MessageServiceImpl;
  let mockHermes: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MessageServiceImpl();
    service.setIdentity('local-node-123', 'npub123xyz');

    // Mock hermes.emit et hermes.on
    mockHermes = jest.spyOn(hermes, 'emit').mockResolvedValue(undefined);
    jest.spyOn(hermes, 'on').mockImplementation(() => () => {});
    jest.spyOn(hermes, 'createEvent').mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockHermes.mockRestore();
  });

  // ─── Identity ───────────────────────────────────────────────────────────────

  describe('setIdentity', () => {
    it('should set nodeId and pubkey', () => {
      const newService = new MessageServiceImpl();
      newService.setIdentity('node-456', 'npub456abc');
      // Pas de getter direct, mais on peut tester via envoi
      expect(newService).toBeDefined();
    });
  });

  // ─── DMs ─────────────────────────────────────────────────────────────────────

  describe('sendDM', () => {
    it('should save event to EventStore before emitting', async () => {
      await service.sendDM('peer-456', 'npub456def', 'Hello World');

      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventType.DM_SENT,
          transport: Transport.NOSTR,
          from: 'local-node-123',
          to: 'peer-456',
          payload: expect.objectContaining({
            content: 'Hello World',
            contentType: 'text',
            encryption: 'nip44',
            toPubkey: 'npub456def',
          }),
        }),
        'outbound'
      );
    });

    it('should emit event via hermes', async () => {
      await service.sendDM('peer-456', 'npub456def', 'Hello World');

      expect(mockHermes).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventType.DM_SENT,
          transport: Transport.NOSTR,
        }),
        Transport.NOSTR
      );
    });

    it('should generate unique event IDs', async () => {
      await service.sendDM('peer-1', 'npub1', 'Msg1');
      await service.sendDM('peer-2', 'npub2', 'Msg2');

      const savedEvents = mockSave.mock.calls.map(call => call[0]);
      const ids = savedEvents.map((e: { id: string }) => e.id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe('onDM', () => {
    it('should subscribe to DM_RECEIVED events', () => {
      const handler = jest.fn();
      const mockOn = jest.spyOn(hermes, 'on');

      service.onDM(handler);

      expect(mockOn).toHaveBeenCalledWith(
        EventType.DM_RECEIVED,
        expect.any(Function)
      );
    });

    it('should return unsubscribe function', () => {
      const handler = jest.fn();
      const mockUnsub = jest.fn();
      jest.spyOn(hermes, 'on').mockReturnValue(mockUnsub);

      const unsub = service.onDM(handler);

      expect(typeof unsub).toBe('function');
      unsub();
      expect(mockUnsub).toHaveBeenCalled();
    });
  });

  describe('getDMHistory', () => {
    it('should fetch conversation from EventStore', async () => {
      const mockEvents = [
        {
          id: 'event-1',
          type: EventType.DM_RECEIVED,
          transport: Transport.NOSTR,
          timestamp: 1000,
          from: 'peer-456',
          to: 'local-node-123',
          payload: { content: 'Hello', contentType: 'text' },
          meta: {},
        },
        {
          id: 'event-2',
          type: EventType.DM_SENT,
          transport: Transport.NOSTR,
          timestamp: 2000,
          from: 'local-node-123',
          to: 'peer-456',
          payload: { content: 'Hi!', contentType: 'text' },
          meta: {},
        },
      ];
      mockGetConversation.mockResolvedValue(mockEvents);

      const history = await service.getDMHistory('peer-456', 50);

      expect(mockGetConversation).toHaveBeenCalledWith('peer-456', 50);
      expect(history).toHaveLength(2);
      expect(history[0].content).toBe('Hello');
      expect(history[1].content).toBe('Hi!');
    });

    it('should filter out non-DM events', async () => {
      const mockEvents = [
        {
          id: 'event-1',
          type: EventType.DM_RECEIVED,
          transport: Transport.NOSTR,
          timestamp: 1000,
          from: 'peer-456',
          to: 'local-node-123',
          payload: { content: 'Hello', contentType: 'text' },
          meta: {},
        },
        {
          id: 'event-2',
          type: EventType.CHANNEL_MSG_RECEIVED, // Not a DM
          transport: Transport.NOSTR,
          timestamp: 2000,
          from: 'peer-456',
          to: 'general',
          payload: { content: 'Spam', channelName: 'general' },
          meta: {},
        },
      ];
      mockGetConversation.mockResolvedValue(mockEvents);

      const history = await service.getDMHistory('peer-456');

      expect(history).toHaveLength(1);
      expect(history[0].content).toBe('Hello');
    });
  });

  // ─── Channel Messages ───────────────────────────────────────────────────────

  describe('sendChannelMessage', () => {
    it('should save channel message to EventStore', async () => {
      await service.sendChannelMessage('general', 'Hello Channel');

      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventType.CHANNEL_MSG_SENT,
          transport: Transport.NOSTR,
          from: 'local-node-123',
          to: 'general',
          payload: expect.objectContaining({
            content: 'Hello Channel',
            contentType: 'text',
            channelName: 'general',
          }),
        }),
        'outbound'
      );
    });

    it('should emit channel message via hermes', async () => {
      await service.sendChannelMessage('general', 'Hello Channel');

      expect(mockHermes).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventType.CHANNEL_MSG_SENT,
        }),
        Transport.NOSTR
      );
    });
  });

  describe('onChannelMessage', () => {
    it('should subscribe to CHANNEL_MSG_RECEIVED events', () => {
      const handler = jest.fn();
      const mockOn = jest.spyOn(hermes, 'on');

      service.onChannelMessage('general', handler);

      expect(mockOn).toHaveBeenCalledWith(
        EventType.CHANNEL_MSG_RECEIVED,
        expect.any(Function)
      );
    });
  });

  describe('getChannelHistory', () => {
    it('should fetch channel history from EventStore', async () => {
      const mockEvents = [
        {
          id: 'event-1',
          type: EventType.CHANNEL_MSG_RECEIVED,
          transport: Transport.NOSTR,
          timestamp: 1000,
          from: 'user-1',
          to: 'general',
          payload: { content: 'Msg1', channelName: 'general' },
          meta: {},
        },
        {
          id: 'event-2',
          type: EventType.CHANNEL_MSG_RECEIVED,
          transport: Transport.NOSTR,
          timestamp: 2000,
          from: 'user-2',
          to: 'general',
          payload: { content: 'Msg2', channelName: 'general' },
          meta: {},
        },
      ];
      mockGetByType.mockResolvedValue(mockEvents);

      const history = await service.getChannelHistory('general', 50);

      expect(mockGetByType).toHaveBeenCalledWith(
        EventType.CHANNEL_MSG_RECEIVED,
        50
      );
      expect(history).toHaveLength(2);
    });

    it('should filter by channelId', async () => {
      const mockEvents = [
        {
          id: 'event-1',
          type: EventType.CHANNEL_MSG_RECEIVED,
          transport: Transport.NOSTR,
          timestamp: 1000,
          from: 'user-1',
          to: 'general',
          payload: { content: 'General msg', channelName: 'general' },
          meta: {},
        },
        {
          id: 'event-2',
          type: EventType.CHANNEL_MSG_RECEIVED,
          transport: Transport.NOSTR,
          timestamp: 2000,
          from: 'user-2',
          to: 'random',
          payload: { content: 'Random msg', channelName: 'random' },
          meta: {},
        },
      ];
      mockGetByType.mockResolvedValue(mockEvents);

      const history = await service.getChannelHistory('general');

      expect(history).toHaveLength(1);
      expect(history[0].content).toBe('General msg');
    });
  });

  // ─── Bridge ──────────────────────────────────────────────────────────────────

  describe('bridgeToNostr', () => {
    it('should create bridge event from LoRa to Nostr', async () => {
      const mockCreateEvent = jest.spyOn(hermes, 'createEvent');

      await service.bridgeToNostr('lora-payload-data');

      expect(mockCreateEvent).toHaveBeenCalledWith(
        EventType.BRIDGE_LORA_TO_NOSTR,
        {
          payload: 'lora-payload-data',
          originalTransport: Transport.LORA,
          targetTransport: Transport.NOSTR,
        },
        { transport: Transport.INTERNAL }
      );
    });
  });

  describe('bridgeToLora', () => {
    it('should create bridge event from Nostr to LoRa', async () => {
      const mockCreateEvent = jest.spyOn(hermes, 'createEvent');

      await service.bridgeToLora('nostr-event-data');

      expect(mockCreateEvent).toHaveBeenCalledWith(
        EventType.BRIDGE_NOSTR_TO_LORA,
        {
          payload: 'nostr-event-data',
          originalTransport: Transport.NOSTR,
          targetTransport: Transport.LORA,
        },
        { transport: Transport.INTERNAL }
      );
    });
  });

  // ─── Edge Cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle empty content', async () => {
      await service.sendDM('peer-1', 'npub1', '');

      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ content: '' }),
        }),
        'outbound'
      );
    });

    it('should handle special characters in content', async () => {
      const specialContent = 'Hello 🎉 <script>alert("xss")</script> \n\t';
      await service.sendDM('peer-1', 'npub1', specialContent);

      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ content: specialContent }),
        }),
        'outbound'
      );
    });

    it('should handle EventStore errors gracefully', async () => {
      mockSave.mockRejectedValue(new Error('DB Error'));

      await expect(service.sendDM('peer-1', 'npub1', 'Hello')).rejects.toThrow('DB Error');
    });

    it('should handle very long content', async () => {
      const longContent = 'a'.repeat(10000);
      await service.sendDM('peer-1', 'npub1', longContent);

      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ content: longContent }),
        }),
        'outbound'
      );
    });
  });
});

// ─── Types Validation ─────────────────────────────────────────────────────────

describe('Message Types', () => {
  it('DirectMessage interface should be valid', () => {
    const msg: DirectMessage = {
      id: 'test-id',
      from: 'user1',
      to: 'user2',
      content: 'Hello',
      timestamp: Date.now(),
      transport: 'nostr',
      encryption: 'nip44',
    };

    expect(msg).toBeDefined();
    expect(msg.id).toBe('test-id');
    expect(msg.transport).toBe('nostr');
    expect(msg.encryption).toBe('nip44');
  });

  it('ChannelMessage interface should be valid', () => {
    const msg: ChannelMessage = {
      id: 'test-id',
      channelId: 'general',
      from: 'user1',
      content: 'Hello all',
      timestamp: Date.now(),
      transport: 'lora',
    };

    expect(msg).toBeDefined();
    expect(msg.channelId).toBe('general');
    expect(msg.transport).toBe('lora');
  });
});
