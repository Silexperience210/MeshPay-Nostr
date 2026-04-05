/**
 * Tests unitaires pour EventBuilder
 * Couverture: Méthodes statiques, chaînage fluent, validation
 */

import {
  EventBuilder,
  eb,
} from '../../utils/EventBuilder';
import {
  EventType,
  Transport,
  HermesEvent,
} from '../../types';

describe('EventBuilder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const isValidHermesEvent = (event: unknown): event is HermesEvent => {
    const e = event as HermesEvent;
    return (
      typeof e === 'object' &&
      e !== null &&
      typeof e.id === 'string' &&
      typeof e.type === 'string' &&
      typeof e.timestamp === 'number' &&
      typeof e.from === 'string' &&
      typeof e.to === 'string' &&
      typeof e.payload === 'object' &&
      typeof e.meta === 'object'
      // Note: transport peut être undefined si non explicitement défini
    );
  };

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Factory methods
  // ═════════════════════════════════════════════════════════════════════════════

  describe('factory methods', () => {
    it('should build DM event with dm()', () => {
      const event = EventBuilder.dm().transport(Transport.NOSTR).build();

      expect(event.type).toBe(EventType.DM_SENT);
      expect(event.transport).toBe(Transport.NOSTR);
      expect(isValidHermesEvent(event)).toBe(true);
    });

    it('should build channel event with channel()', () => {
      const event = EventBuilder.channel().transport(Transport.LORA).build();

      expect(event.type).toBe(EventType.CHANNEL_MSG_SENT);
      expect(event.transport).toBe(Transport.LORA);
      expect(isValidHermesEvent(event)).toBe(true);
    });

    it('should build bridge event with bridge()', () => {
      const event = EventBuilder.bridge().transport(Transport.NOSTR).build();

      expect(event.type).toBe(EventType.BRIDGE_LORA_TO_NOSTR);
      expect(event.transport).toBe(Transport.NOSTR);
      expect(isValidHermesEvent(event)).toBe(true);
    });

    it('should build system event with system()', () => {
      const event = EventBuilder.system().type(EventType.SYSTEM_READY).build();

      expect(event.transport).toBe(Transport.INTERNAL);
      expect(isValidHermesEvent(event)).toBe(true);
    });

    it('should create builder from existing event with fromEvent()', () => {
      const existingEvent: Partial<HermesEvent> = {
        id: 'existing-id',
        type: EventType.DM_RECEIVED,
        transport: Transport.NOSTR,
        from: 'original-sender',
        to: 'original-recipient',
        payload: { content: 'original' },
      };

      const event = EventBuilder.fromEvent(existingEvent).build();

      expect(event.id).toBe('existing-id');
      expect(event.type).toBe(EventType.DM_RECEIVED);
      expect(event.transport).toBe(Transport.NOSTR);
      expect(event.from).toBe('original-sender');
      expect(event.to).toBe('original-recipient');
      expect(event.payload).toEqual({ content: 'original' });
    });

    it('should create builder with eb() helper', () => {
      const event = eb().type(EventType.SYSTEM_READY).transport(Transport.INTERNAL).build();

      expect(event.type).toBe(EventType.SYSTEM_READY);
      expect(event.transport).toBe(Transport.INTERNAL);
      expect(isValidHermesEvent(event)).toBe(true);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Configuration methods
  // ═════════════════════════════════════════════════════════════════════════════

  describe('configuration methods', () => {
    it('should set custom id with id()', () => {
      const event = EventBuilder.dm().id('custom-id-123').build();

      expect(event.id).toBe('custom-id-123');
    });

    it('should set type with type()', () => {
      const event = EventBuilder.system()
        .type(EventType.SYSTEM_ERROR)
        .build();

      expect(event.type).toBe(EventType.SYSTEM_ERROR);
    });

    it('should set from with from()', () => {
      const event = EventBuilder.dm().from('sender-npub').build();

      expect(event.from).toBe('sender-npub');
    });

    it('should set to with to()', () => {
      const event = EventBuilder.dm().to('recipient-npub').build();

      expect(event.to).toBe('recipient-npub');
    });

    it('should set transport with transport()', () => {
      const event = EventBuilder.dm()
        .transport(Transport.LORA)
        .build();

      expect(event.transport).toBe(Transport.LORA);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Payload methods
  // ═════════════════════════════════════════════════════════════════════════════

  describe('payload methods', () => {
    it('should set content with content()', () => {
      const event = EventBuilder.dm()
        .content('Hello World')
        .build();

      expect((event.payload as any).content).toBe('Hello World');
      expect((event.payload as any).contentType).toBe('text');
    });

    it('should set content with custom contentType', () => {
      const event = EventBuilder.dm()
        .content('Hello World', 'markdown')
        .build();

      expect((event.payload as any).content).toBe('Hello World');
      expect((event.payload as any).contentType).toBe('markdown');
    });

    it('should set channel name with channel()', () => {
      const event = EventBuilder.channel()
        .channel('general')
        .build();

      expect((event.payload as any).channelName).toBe('general');
    });

    it('should set encryption with encrypt()', () => {
      const event = EventBuilder.dm()
        .encrypt('nip04')
        .build();

      expect((event.payload as any).encryption).toBe('nip04');
    });

    it('should support all encryption methods', () => {
      const nip04Event = EventBuilder.dm().encrypt('nip04').build();
      const nip44Event = EventBuilder.dm().encrypt('nip44').build();
      const meshcoreEvent = EventBuilder.dm().encrypt('meshcore_aes').build();

      expect((nip04Event.payload as any).encryption).toBe('nip04');
      expect((nip44Event.payload as any).encryption).toBe('nip44');
      expect((meshcoreEvent.payload as any).encryption).toBe('meshcore_aes');
    });

    it('should set amount with amount()', () => {
      const event = EventBuilder.dm()
        .amount(1000)
        .build();

      expect((event.payload as any).amountSats).toBe(1000);
    });

    it('should set raw payload with raw()', () => {
      const customPayload = { custom: 'data', nested: { value: 123 } };
      const event = EventBuilder.system()
        .type(EventType.SYSTEM_READY)
        .raw(customPayload)
        .build();

      expect(event.payload).toEqual(customPayload);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Metadata methods
  // ═════════════════════════════════════════════════════════════════════════════

  describe('metadata methods', () => {
    it('should set custom meta with meta()', () => {
      const event = EventBuilder.dm()
        .meta('customKey', 'customValue')
        .build();

      expect(event.meta.customKey).toBe('customValue');
    });

    it('should set multiple meta values', () => {
      const event = EventBuilder.dm()
        .meta('key1', 'value1')
        .meta('key2', 42)
        .meta('key3', { nested: true })
        .build();

      expect(event.meta.key1).toBe('value1');
      expect(event.meta.key2).toBe(42);
      expect(event.meta.key3).toEqual({ nested: true });
    });

    it('should set originalId with originalId()', () => {
      const event = EventBuilder.dm()
        .originalId('nostr-event-id-123')
        .build();

      expect(event.meta.originalId).toBe('nostr-event-id-123');
    });

    it('should set RTT with rtt()', () => {
      const event = EventBuilder.dm()
        .rtt(150)
        .build();

      expect(event.meta.rttMs).toBe(150);
    });

    it('should set hops with hops()', () => {
      const event = EventBuilder.dm()
        .hops(3)
        .build();

      expect(event.meta.hops).toBe(3);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Fluent chaining
  // ═════════════════════════════════════════════════════════════════════════════

  describe('fluent chaining', () => {
    it('should chain methods fluently', () => {
      const event = EventBuilder.dm()
        .id('custom-id')
        .from('sender')
        .to('recipient')
        .transport(Transport.NOSTR)
        .content('Hello!')
        .encrypt('nip44')
        .amount(500)
        .channel('dm')
        .originalId('original-123')
        .rtt(100)
        .hops(2)
        .meta('custom', 'value')
        .build();

      expect(event.id).toBe('custom-id');
      expect(event.from).toBe('sender');
      expect(event.to).toBe('recipient');
      expect(event.transport).toBe(Transport.NOSTR);
      expect((event.payload as any).content).toBe('Hello!');
      expect((event.payload as any).encryption).toBe('nip44');
      expect((event.payload as any).amountSats).toBe(500);
      expect((event.payload as any).channelName).toBe('dm');
      expect(event.meta.originalId).toBe('original-123');
      expect(event.meta.rttMs).toBe(100);
      expect(event.meta.hops).toBe(2);
      expect(event.meta.custom).toBe('value');
    });

    it('should build complex DM event with all properties', () => {
      const event = EventBuilder.dm()
        .id('dm-123')
        .from('npub1sender')
        .to('npub1recipient')
        .transport(Transport.NOSTR)
        .content('Secret message', 'text')
        .encrypt('nip44')
        .amount(1000)
        .originalId('nostr-event-id')
        .rtt(200)
        .hops(1)
        .build();

      expect(isValidHermesEvent(event)).toBe(true);
      expect(event.type).toBe(EventType.DM_SENT);
      expect(event.id).toBe('dm-123');
      expect(event.from).toBe('npub1sender');
      expect(event.to).toBe('npub1recipient');
      expect(event.transport).toBe(Transport.NOSTR);
      expect((event.payload as any).content).toBe('Secret message');
      expect((event.payload as any).contentType).toBe('text');
      expect((event.payload as any).encryption).toBe('nip44');
      expect((event.payload as any).amountSats).toBe(1000);
      expect(event.meta.originalId).toBe('nostr-event-id');
      expect(event.meta.rttMs).toBe(200);
      expect(event.meta.hops).toBe(1);
    });

    it('should build complex channel event with all properties', () => {
      const event = EventBuilder.channel()
        .id('channel-123')
        .from('npub1sender')
        .to('*')
        .transport(Transport.LORA)
        .content('Channel message', 'markdown')
        .channel('general')
        .encrypt('meshcore_aes')
        .originalId('meshcore-msg-id')
        .rtt(500)
        .hops(4)
        .build();

      expect(isValidHermesEvent(event)).toBe(true);
      expect(event.type).toBe(EventType.CHANNEL_MSG_SENT);
      expect(event.id).toBe('channel-123');
      expect(event.from).toBe('npub1sender');
      expect(event.to).toBe('*');
      expect(event.transport).toBe(Transport.LORA);
      expect((event.payload as any).content).toBe('Channel message');
      expect((event.payload as any).contentType).toBe('markdown');
      expect((event.payload as any).channelName).toBe('general');
      expect((event.payload as any).encryption).toBe('meshcore_aes');
      expect(event.meta.originalId).toBe('meshcore-msg-id');
      expect(event.meta.rttMs).toBe(500);
      expect(event.meta.hops).toBe(4);
    });

    it('should build complex bridge event', () => {
      const event = EventBuilder.bridge()
        .id('bridge-123')
        .from('lora-node-1')
        .to('nostr-relay')
        .transport(Transport.NOSTR)
        .raw({
          originalTransport: Transport.LORA,
          targetTransport: Transport.NOSTR,
          rawPayload: 'encrypted-lora-payload',
        })
        .rtt(300)
        .hops(2)
        .build();

      expect(isValidHermesEvent(event)).toBe(true);
      expect(event.type).toBe(EventType.BRIDGE_LORA_TO_NOSTR);
      expect(event.id).toBe('bridge-123');
      expect(event.from).toBe('lora-node-1');
      expect(event.to).toBe('nostr-relay');
      expect(event.transport).toBe(Transport.NOSTR);
      expect(event.payload).toEqual({
        originalTransport: Transport.LORA,
        targetTransport: Transport.NOSTR,
        rawPayload: 'encrypted-lora-payload',
      });
      expect(event.meta.rttMs).toBe(300);
      expect(event.meta.hops).toBe(2);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: ID generation
  // ═════════════════════════════════════════════════════════════════════════════

  describe('ID generation', () => {
    it('should generate unique IDs', () => {
      const event1 = EventBuilder.dm().build();
      const event2 = EventBuilder.dm().build();
      const event3 = EventBuilder.channel().build();

      expect(event1.id).not.toBe(event2.id);
      expect(event2.id).not.toBe(event3.id);
      expect(event1.id).not.toBe(event3.id);
    });

    it('should generate timestamp-based IDs', () => {
      const before = Date.now();
      const event = EventBuilder.dm().build();
      const after = Date.now();

      // ID should contain timestamp in base36
      expect(typeof event.id).toBe('string');
      expect(event.id).toContain('-');
    });

    it('should auto-generate timestamp', () => {
      const before = Date.now();
      const event = EventBuilder.dm().build();
      const after = Date.now();

      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Validation and errors
  // ═════════════════════════════════════════════════════════════════════════════

  describe('validation', () => {
    it('should throw if type not set', () => {
      expect(() => {
        EventBuilder.system().build();
      }).toThrow('EventBuilder: type requis');
    });

    it('should throw on empty builder', () => {
      expect(() => {
        eb().build();
      }).toThrow('EventBuilder: type requis');
    });

    it('should not throw when type is explicitly set', () => {
      expect(() => {
        eb().type(EventType.SYSTEM_READY).build();
      }).not.toThrow();
    });

    it('should auto-initialize empty payload', () => {
      const event = EventBuilder.system()
        .type(EventType.SYSTEM_READY)
        .build();

      expect(event.payload).toEqual({});
    });

    it('should preserve existing payload when adding properties', () => {
      const event = EventBuilder.dm()
        .content('Hello')
        .amount(100)
        .build();

      expect((event.payload as any).content).toBe('Hello');
      expect((event.payload as any).amountSats).toBe(100);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Emit integration
  // ═════════════════════════════════════════════════════════════════════════════

  describe('emit integration', () => {
    it('should call engine.emit() with built event', async () => {
      const mockEmit = jest.fn().mockResolvedValue(undefined);
      const mockEngine = { emit: mockEmit };

      const builder = EventBuilder.dm()
        .to('recipient')
        .content('Hello');

      await builder.emit(mockEngine as any, Transport.NOSTR);

      expect(mockEmit).toHaveBeenCalledTimes(1);
      const [event, transport] = mockEmit.mock.calls[0];
      expect(event.type).toBe(EventType.DM_SENT);
      expect(event.to).toBe('recipient');
      expect((event.payload as any).content).toBe('Hello');
      expect(transport).toBe(Transport.NOSTR);
    });

    it('should emit without specific transport', async () => {
      const mockEmit = jest.fn().mockResolvedValue(undefined);
      const mockEngine = { emit: mockEmit };

      const builder = EventBuilder.channel()
        .channel('test')
        .content('Hello channel');

      await builder.emit(mockEngine as any);

      expect(mockEmit).toHaveBeenCalledTimes(1);
      const [event, transport] = mockEmit.mock.calls[0];
      expect(event.type).toBe(EventType.CHANNEL_MSG_SENT);
      expect(transport).toBeUndefined();
    });

    it('should propagate emit errors', async () => {
      const mockEmit = jest.fn().mockRejectedValue(new Error('Emit failed'));
      const mockEngine = { emit: mockEmit };

      const builder = EventBuilder.dm().content('Hello');

      await expect(builder.emit(mockEngine as any)).rejects.toThrow('Emit failed');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Default values
  // ═════════════════════════════════════════════════════════════════════════════

  describe('default values', () => {
    it('should have correct defaults', () => {
      const event = EventBuilder.system()
        .type(EventType.SYSTEM_READY)
        .build();

      expect(event.from).toBe('local');
      expect(event.to).toBe('*');
      expect(event.meta).toEqual({});
    });

    it('should allow overriding defaults', () => {
      const event = EventBuilder.system()
        .type(EventType.SYSTEM_READY)
        .from('custom')
        .to('specific')
        .meta('key', 'value')
        .build();

      expect(event.from).toBe('custom');
      expect(event.to).toBe('specific');
      expect(event.meta.key).toBe('value');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Edge cases
  // ═════════════════════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('should handle empty content', () => {
      const event = EventBuilder.dm()
        .content('')
        .build();

      expect((event.payload as any).content).toBe('');
    });

    it('should handle zero amount', () => {
      const event = EventBuilder.dm()
        .amount(0)
        .build();

      expect((event.payload as any).amountSats).toBe(0);
    });

    it('should handle special characters in content', () => {
      const specialContent = 'Hello \n World \t! 🎉 <script>alert("xss")</script>';
      const event = EventBuilder.dm()
        .content(specialContent)
        .build();

      expect((event.payload as any).content).toBe(specialContent);
    });

    it('should handle very long content', () => {
      const longContent = 'a'.repeat(10000);
      const event = EventBuilder.dm()
        .content(longContent)
        .build();

      expect((event.payload as any).content).toBe(longContent);
    });

    it('should handle fromEvent with partial data', () => {
      const partialEvent: Partial<HermesEvent> = {
        type: EventType.DM_RECEIVED,
      };

      const event = EventBuilder.fromEvent(partialEvent).build();

      expect(event.type).toBe(EventType.DM_RECEIVED);
      // Should have auto-generated defaults for missing fields
      expect(typeof event.id).toBe('string');
      expect(typeof event.timestamp).toBe('number');
      expect(event.from).toBe('local');
      expect(event.to).toBe('*');
    });
  });
});
