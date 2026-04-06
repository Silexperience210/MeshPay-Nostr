/**
 * Tests unitaires pour HermesEngine
 * Couverture: 100% des fonctionnalités critiques
 */

import { HermesEngine, ProtocolAdapter } from '../../HermesEngine';
import {
  Transport,
  EventType,
  HermesEvent,
  HermesConfig,
} from '../../types';

describe('HermesEngine', () => {
  let engine: HermesEngine;

  beforeEach(() => {
    jest.clearAllMocks();
    engine = new HermesEngine({ debug: false });
  });

  afterEach(async () => {
    await engine.stop();
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const createMockAdapter = (
    name: Transport = Transport.NOSTR,
    isConnected = true
  ): ProtocolAdapter => ({
    name,
    isConnected,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    onMessage: jest.fn().mockReturnValue(() => {}),
  });

  const createMockEvent = (
    type: EventType = EventType.DM_RECEIVED,
    transport: Transport = Transport.NOSTR,
    overrides: Partial<HermesEvent> = {}
  ): HermesEvent => ({
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    transport,
    timestamp: Date.now(),
    from: 'test-sender',
    to: 'test-recipient',
    payload: { content: 'test message' },
    meta: {},
    ...overrides,
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Registration
  // ═════════════════════════════════════════════════════════════════════════════

  describe('registration', () => {
    it('should register adapter successfully', () => {
      const mockAdapter = createMockAdapter(Transport.NOSTR);

      engine.registerAdapter(mockAdapter);

      expect(engine.getAdapter(Transport.NOSTR)).toBe(mockAdapter);
      expect(mockAdapter.onMessage).toHaveBeenCalled();
    });

    it('should throw when registering duplicate adapter', () => {
      const mockAdapter1 = createMockAdapter(Transport.NOSTR);
      const mockAdapter2 = createMockAdapter(Transport.NOSTR);

      engine.registerAdapter(mockAdapter1);

      expect(() => engine.registerAdapter(mockAdapter2)).toThrow(
        'Adapter nostr déjà enregistré'
      );
    });

    it('should unregister adapter', async () => {
      const mockAdapter = createMockAdapter(Transport.NOSTR);
      engine.registerAdapter(mockAdapter);

      engine.unregisterAdapter(Transport.NOSTR);

      expect(engine.getAdapter(Transport.NOSTR)).toBeUndefined();
      expect(mockAdapter.stop).toHaveBeenCalled();
    });

    it('should handle unregistering non-existent adapter gracefully', () => {
      expect(() => engine.unregisterAdapter(Transport.NOSTR)).not.toThrow();
    });

    it('should register multiple different adapters', () => {
      const nostrAdapter = createMockAdapter(Transport.NOSTR);
      const loraAdapter = createMockAdapter(Transport.LORA);
      const usbAdapter = createMockAdapter(Transport.USB);

      engine.registerAdapter(nostrAdapter);
      engine.registerAdapter(loraAdapter);
      engine.registerAdapter(usbAdapter);

      expect(engine.getAdapter(Transport.NOSTR)).toBe(nostrAdapter);
      expect(engine.getAdapter(Transport.LORA)).toBe(loraAdapter);
      expect(engine.getAdapter(Transport.USB)).toBe(usbAdapter);
      expect(engine.stats.adapters).toBe(3);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Lifecycle
  // ═════════════════════════════════════════════════════════════════════════════

  describe('lifecycle', () => {
    it('should start all adapters', async () => {
      const nostrAdapter = createMockAdapter(Transport.NOSTR);
      const loraAdapter = createMockAdapter(Transport.LORA);

      engine.registerAdapter(nostrAdapter);
      engine.registerAdapter(loraAdapter);

      await engine.start();

      expect(nostrAdapter.start).toHaveBeenCalled();
      expect(loraAdapter.start).toHaveBeenCalled();
      expect(engine.stats.isRunning).toBe(true);
    });

    it('should stop all adapters', async () => {
      const nostrAdapter = createMockAdapter(Transport.NOSTR);
      const loraAdapter = createMockAdapter(Transport.LORA);

      engine.registerAdapter(nostrAdapter);
      engine.registerAdapter(loraAdapter);
      await engine.start();

      await engine.stop();

      expect(nostrAdapter.stop).toHaveBeenCalled();
      expect(loraAdapter.stop).toHaveBeenCalled();
      expect(engine.stats.isRunning).toBe(false);
    });

    it('should emit SYSTEM_READY on start', async () => {
      const systemReadyHandler = jest.fn();
      engine.on(EventType.SYSTEM_READY, systemReadyHandler);

      await engine.start();

      expect(systemReadyHandler).toHaveBeenCalledTimes(1);
      const event = systemReadyHandler.mock.calls[0][0];
      expect(event.type).toBe(EventType.SYSTEM_READY);
      expect(event.transport).toBe(Transport.INTERNAL);
      expect(event.payload.adapters).toEqual([]);
    });

    it('should handle adapter start failure gracefully', async () => {
      const failingAdapter = createMockAdapter(Transport.NOSTR);
      failingAdapter.start = jest.fn().mockRejectedValue(new Error('Start failed'));

      engine.registerAdapter(failingAdapter);

      // Should not throw
      await expect(engine.start()).resolves.toBeUndefined();
      expect(engine.stats.isRunning).toBe(true);
    });

    it('should handle adapter stop failure gracefully', async () => {
      const failingAdapter = createMockAdapter(Transport.NOSTR);
      failingAdapter.stop = jest.fn().mockRejectedValue(new Error('Stop failed'));

      engine.registerAdapter(failingAdapter);
      await engine.start();

      // Should not throw
      await expect(engine.stop()).resolves.toBeUndefined();
    });

    it('should not start adapters disabled in config', async () => {
      const config: Partial<HermesConfig> = {
        debug: false,
        adapters: { nostr: false, lora: true, usb: false },
      };
      const customEngine = new HermesEngine(config);

      const nostrAdapter = createMockAdapter(Transport.NOSTR);
      const loraAdapter = createMockAdapter(Transport.LORA);

      customEngine.registerAdapter(nostrAdapter);
      customEngine.registerAdapter(loraAdapter);

      await customEngine.start();

      expect(nostrAdapter.start).not.toHaveBeenCalled();
      expect(loraAdapter.start).toHaveBeenCalled();

      await customEngine.stop();
    });

    it('should handle multiple start calls gracefully', async () => {
      const adapter = createMockAdapter(Transport.NOSTR);
      engine.registerAdapter(adapter);

      await engine.start();
      await engine.start(); // Second call

      expect(adapter.start).toHaveBeenCalledTimes(1);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Event Routing
  // ═════════════════════════════════════════════════════════════════════════════

  describe('event routing', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('should route event to correct handler', async () => {
      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const event = createMockEvent(EventType.DM_RECEIVED);
      await engine.emit(event);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('should route to multiple handlers', async () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler1);
      engine.on(EventType.DM_RECEIVED, handler2);

      const event = createMockEvent(EventType.DM_RECEIVED);
      await engine.emit(event);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should filter by type', async () => {
      const dmHandler = jest.fn();
      const channelHandler = jest.fn();
      engine.on(EventType.DM_RECEIVED, dmHandler);
      engine.on(EventType.CHANNEL_MSG_RECEIVED, channelHandler);

      const dmEvent = createMockEvent(EventType.DM_RECEIVED);
      const channelEvent = createMockEvent(EventType.CHANNEL_MSG_RECEIVED);

      await engine.emit(dmEvent);
      await engine.emit(channelEvent);

      expect(dmHandler).toHaveBeenCalledTimes(1);
      expect(channelHandler).toHaveBeenCalledTimes(1);
      expect(dmHandler).toHaveBeenCalledWith(dmEvent);
      expect(channelHandler).toHaveBeenCalledWith(channelEvent);
    });

    it('should filter by transport', async () => {
      const handler = jest.fn();
      engine.subscribe(
        { types: [EventType.DM_RECEIVED], transports: [Transport.NOSTR] },
        handler
      );

      const nostrEvent = createMockEvent(EventType.DM_RECEIVED, Transport.NOSTR);
      const loraEvent = createMockEvent(EventType.DM_RECEIVED, Transport.LORA);

      await engine.emit(nostrEvent);
      await engine.emit(loraEvent);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(nostrEvent);
    });

    it('should filter by custom function', async () => {
      const handler = jest.fn();
      const customFilter = (event: HermesEvent) =>
        event.from === 'allowed-sender';

      engine.subscribe(
        {
          types: [EventType.DM_RECEIVED],
          custom: customFilter,
        },
        handler
      );

      const allowedEvent = createMockEvent(EventType.DM_RECEIVED, Transport.NOSTR, {
        from: 'allowed-sender',
      });
      const blockedEvent = createMockEvent(EventType.DM_RECEIVED, Transport.NOSTR, {
        from: 'blocked-sender',
      });

      await engine.emit(allowedEvent);
      await engine.emit(blockedEvent);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(allowedEvent);
    });

    it('should filter by from field', async () => {
      const handler = jest.fn();
      engine.subscribe(
        { types: [EventType.DM_RECEIVED], from: ['specific-sender'] },
        handler
      );

      const matchingEvent = createMockEvent(EventType.DM_RECEIVED, Transport.NOSTR, {
        from: 'specific-sender',
      });
      const nonMatchingEvent = createMockEvent(EventType.DM_RECEIVED, Transport.NOSTR, {
        from: 'other-sender',
      });

      await engine.emit(matchingEvent);
      await engine.emit(nonMatchingEvent);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(matchingEvent);
    });

    it('should filter by to field', async () => {
      const handler = jest.fn();
      engine.subscribe(
        { types: [EventType.DM_RECEIVED], to: ['specific-recipient'] },
        handler
      );

      const matchingEvent = createMockEvent(EventType.DM_RECEIVED, Transport.NOSTR, {
        to: 'specific-recipient',
      });
      const broadcastEvent = createMockEvent(EventType.DM_RECEIVED, Transport.NOSTR, {
        to: '*',
      });
      const nonMatchingEvent = createMockEvent(EventType.DM_RECEIVED, Transport.NOSTR, {
        to: 'other-recipient',
      });

      await engine.emit(matchingEvent);
      await engine.emit(broadcastEvent);
      await engine.emit(nonMatchingEvent);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith(matchingEvent);
      expect(handler).toHaveBeenCalledWith(broadcastEvent);
    });

    it('should route incoming events from adapters', async () => {
      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const mockAdapter = createMockAdapter(Transport.NOSTR);
      let messageHandler: ((event: HermesEvent) => void) | undefined;
      mockAdapter.onMessage = jest.fn((handler) => {
        messageHandler = handler;
        return () => {};
      });

      engine.registerAdapter(mockAdapter);
      await engine.start();

      const incomingEvent = createMockEvent(EventType.DM_RECEIVED);
      messageHandler!(incomingEvent);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].transport).toBe(Transport.NOSTR);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Deduplication
  // ═════════════════════════════════════════════════════════════════════════════

  describe('deduplication', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('should deduplicate identical events', async () => {
      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const event = createMockEvent(EventType.DM_RECEIVED);

      await engine.emit(event);
      await engine.emit(event); // Same event, same ID

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should allow different events', async () => {
      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const event1 = createMockEvent(EventType.DM_RECEIVED);
      const event2 = createMockEvent(EventType.DM_RECEIVED);

      await engine.emit(event1);
      await engine.emit(event2);

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should deduplicate incoming events from adapters', async () => {
      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const mockAdapter = createMockAdapter(Transport.NOSTR);
      let messageHandler: ((event: HermesEvent) => void) | undefined;
      mockAdapter.onMessage = jest.fn((handler) => {
        messageHandler = handler;
        return () => {};
      });

      engine.registerAdapter(mockAdapter);
      await engine.start();

      const event = createMockEvent(EventType.DM_RECEIVED);
      messageHandler!(event);
      messageHandler!(event); // Duplicate

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should track deduplication window size', async () => {
      await engine.start();

      // SYSTEM_READY est déjà émis au démarrage
      const initialDedupSize = engine.stats.dedupSize;

      const event1 = createMockEvent(EventType.DM_RECEIVED);
      const event2 = createMockEvent(EventType.DM_RECEIVED);

      await engine.emit(event1);
      expect(engine.stats.dedupSize).toBe(initialDedupSize + 1);

      await engine.emit(event2);
      expect(engine.stats.dedupSize).toBe(initialDedupSize + 2);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Subscriptions
  // ═════════════════════════════════════════════════════════════════════════════

  describe('subscriptions', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('should subscribe with on()', async () => {
      const handler = jest.fn();
      const unsubscribe = engine.on(EventType.DM_RECEIVED, handler);

      const event = createMockEvent(EventType.DM_RECEIVED);
      await engine.emit(event);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(typeof unsubscribe).toBe('function');
    });

    it('should subscribe once with once()', async () => {
      const handler = jest.fn();
      engine.once(EventType.DM_RECEIVED, handler);

      const event1 = createMockEvent(EventType.DM_RECEIVED);
      const event2 = createMockEvent(EventType.DM_RECEIVED);

      await engine.emit(event1);
      await engine.emit(event2);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should unsubscribe correctly', async () => {
      const handler = jest.fn();
      const unsubscribe = engine.on(EventType.DM_RECEIVED, handler);

      const event1 = createMockEvent(EventType.DM_RECEIVED);
      await engine.emit(event1);
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      const event2 = createMockEvent(EventType.DM_RECEIVED);
      await engine.emit(event2);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should handle maxCalls option', async () => {
      const handler = jest.fn();
      engine.subscribe({ types: [EventType.DM_RECEIVED] }, handler, 2);

      const event1 = createMockEvent(EventType.DM_RECEIVED);
      const event2 = createMockEvent(EventType.DM_RECEIVED);
      const event3 = createMockEvent(EventType.DM_RECEIVED);

      await engine.emit(event1);
      await engine.emit(event2);
      await engine.emit(event3);

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should handle async handlers', async () => {
      const asyncHandler = jest.fn().mockResolvedValue(undefined);
      engine.on(EventType.DM_RECEIVED, asyncHandler);

      const event = createMockEvent(EventType.DM_RECEIVED);
      await engine.emit(event);

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(asyncHandler).toHaveBeenCalledTimes(1);
    });

    it('should handle async handler errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const errorHandler = jest.fn().mockRejectedValue(new Error('Async error'));

      engine.on(EventType.DM_RECEIVED, errorHandler);

      const event = createMockEvent(EventType.DM_RECEIVED);
      await engine.emit(event);

      // Wait for async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should handle sync handler errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const errorHandler = jest.fn().mockImplementation(() => {
        throw new Error('Sync error');
      });

      engine.on(EventType.DM_RECEIVED, errorHandler);

      const event = createMockEvent(EventType.DM_RECEIVED);
      await engine.emit(event);

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should track subscription count', async () => {
      expect(engine.stats.subscriptions).toBe(0);

      const unsub1 = engine.on(EventType.DM_RECEIVED, jest.fn());
      expect(engine.stats.subscriptions).toBe(1);

      const unsub2 = engine.on(EventType.CHANNEL_MSG_RECEIVED, jest.fn());
      expect(engine.stats.subscriptions).toBe(2);

      unsub1();
      expect(engine.stats.subscriptions).toBe(1);

      unsub2();
      expect(engine.stats.subscriptions).toBe(0);
    });

    it('should support on() with from filter', async () => {
      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler, { from: 'specific-sender' });

      const matchingEvent = createMockEvent(EventType.DM_RECEIVED, Transport.NOSTR, {
        from: 'specific-sender',
      });
      const nonMatchingEvent = createMockEvent(EventType.DM_RECEIVED, Transport.NOSTR, {
        from: 'other-sender',
      });

      await engine.emit(matchingEvent);
      await engine.emit(nonMatchingEvent);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(matchingEvent);
    });

    it('should support on() with to filter', async () => {
      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler, { to: 'specific-recipient' });

      const matchingEvent = createMockEvent(EventType.DM_RECEIVED, Transport.NOSTR, {
        to: 'specific-recipient',
      });
      const nonMatchingEvent = createMockEvent(EventType.DM_RECEIVED, Transport.NOSTR, {
        to: 'other-recipient',
      });

      await engine.emit(matchingEvent);
      await engine.emit(nonMatchingEvent);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should clear subscriptions on stop', async () => {
      engine.on(EventType.DM_RECEIVED, jest.fn());
      expect(engine.stats.subscriptions).toBe(1);

      await engine.stop();

      expect(engine.stats.subscriptions).toBe(0);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Emit
  // ═════════════════════════════════════════════════════════════════════════════

  describe('emit', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('should emit to specific transport', async () => {
      const mockAdapter = createMockAdapter(Transport.NOSTR, true);
      engine.registerAdapter(mockAdapter);

      const event = createMockEvent(EventType.DM_SENT);
      await engine.emit(event, Transport.NOSTR);

      expect(mockAdapter.send).toHaveBeenCalledTimes(1);
      expect(mockAdapter.send).toHaveBeenCalledWith(event);
    });

    it('should throw if transport not available', async () => {
      const event = createMockEvent(EventType.DM_SENT);

      await expect(engine.emit(event, Transport.NOSTR)).rejects.toThrow(
        'Transport nostr non disponible'
      );
    });

    it('should throw if transport not connected', async () => {
      const mockAdapter = createMockAdapter(Transport.NOSTR, false);
      engine.registerAdapter(mockAdapter);

      const event = createMockEvent(EventType.DM_SENT);

      await expect(engine.emit(event, Transport.NOSTR)).rejects.toThrow(
        'Transport nostr non disponible'
      );
    });

    it('should throw if engine not started', async () => {
      const stoppedEngine = new HermesEngine({ debug: false });
      const event = createMockEvent(EventType.DM_RECEIVED);

      await expect(stoppedEngine.emit(event)).rejects.toThrow(
        'Hermès Engine non démarré'
      );
    });

    it('should call adapter.send()', async () => {
      const mockAdapter = createMockAdapter(Transport.NOSTR, true);
      engine.registerAdapter(mockAdapter);

      const event = createMockEvent(EventType.DM_SENT);
      await engine.emit(event, Transport.NOSTR);

      expect(mockAdapter.send).toHaveBeenCalledTimes(1);
    });

    it('should handle adapter send failure', async () => {
      const mockAdapter = createMockAdapter(Transport.NOSTR, true);
      mockAdapter.send = jest.fn().mockRejectedValue(new Error('Send failed'));
      engine.registerAdapter(mockAdapter);

      const event = createMockEvent(EventType.DM_SENT);

      await expect(engine.emit(event, Transport.NOSTR)).rejects.toThrow('Send failed');
    });

    it('should still dispatch locally when targeting specific transport', async () => {
      const mockAdapter = createMockAdapter(Transport.NOSTR, true);
      engine.registerAdapter(mockAdapter);

      const localHandler = jest.fn();
      engine.on(EventType.DM_SENT, localHandler);

      const event = createMockEvent(EventType.DM_SENT);
      await engine.emit(event, Transport.NOSTR);

      expect(mockAdapter.send).toHaveBeenCalledTimes(1);
      expect(localHandler).toHaveBeenCalledTimes(1);
    });

    it('should emit event without targeting specific transport', async () => {
      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const event = createMockEvent(EventType.DM_RECEIVED);
      await engine.emit(event); // No target transport

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: createEvent helper
  // ═════════════════════════════════════════════════════════════════════════════

  describe('createEvent', () => {
    beforeEach(async () => {
      await engine.start();
    });

    it('should create and emit event with minimal options', async () => {
      const handler = jest.fn();
      engine.on(EventType.SYSTEM_ERROR, handler);

      await engine.createEvent(EventType.SYSTEM_ERROR, { message: 'test error' });

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0];
      expect(event.type).toBe(EventType.SYSTEM_ERROR);
      expect(event.payload).toEqual({ message: 'test error' });
      expect(event.from).toBe('local');
      expect(event.to).toBe('*');
      expect(event.transport).toBe(Transport.INTERNAL);
    });

    it('should create event with custom options', async () => {
      const handler = jest.fn();
      engine.on(EventType.DM_SENT, handler);

      // Enregistrer un adapter NOSTR pour que createEvent fonctionne avec transport: NOSTR
      const mockAdapter = createMockAdapter(Transport.NOSTR, true);
      engine.registerAdapter(mockAdapter);

      await engine.createEvent(
        EventType.DM_SENT,
        { content: 'hello' },
        {
          from: 'custom-sender',
          to: 'custom-recipient',
          transport: Transport.NOSTR,
          meta: { customField: 'value' } as any,
        }
      );

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0];
      expect(event.from).toBe('custom-sender');
      expect(event.to).toBe('custom-recipient');
      expect((event.meta as any).customField).toBe('value');
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Error handling
  // ═════════════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    it('should register error handlers', async () => {
      await engine.start();

      const errorHandler = jest.fn();
      const unsubscribe = engine.onError(errorHandler);

      // Trigger an error by emitting with a failing handler
      engine.on(EventType.DM_RECEIVED, () => {
        throw new Error('Handler error');
      });

      const event = createMockEvent(EventType.DM_RECEIVED);
      await engine.emit(event);

      expect(errorHandler).toHaveBeenCalled();
      expect(typeof unsubscribe).toBe('function');
    });

    it('should unsubscribe from error handlers', async () => {
      await engine.start();

      const errorHandler = jest.fn();
      const unsubscribe = engine.onError(errorHandler);
      unsubscribe();

      // Trigger an error
      engine.on(EventType.DM_RECEIVED, () => {
        throw new Error('Handler error');
      });

      const event = createMockEvent(EventType.DM_RECEIVED);
      await engine.emit(event);

      // Error handler should not be called after unsubscribe
      // (but we can't easily verify this since console.error is also called)
      expect(errorHandler).not.toHaveBeenCalled();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Stats and history
  // ═════════════════════════════════════════════════════════════════════════════

  describe('stats and history', () => {
    it('should return correct stats', async () => {
      expect(engine.stats).toEqual({
        adapters: 0,
        subscriptions: 0,
        dedupSize: 0,
        isRunning: false,
      });

      engine.registerAdapter(createMockAdapter(Transport.NOSTR));
      engine.on(EventType.DM_RECEIVED, jest.fn());
      await engine.start();

      const stats = engine.stats;
      expect(stats.adapters).toBe(1);
      expect(stats.subscriptions).toBe(1);
      expect(stats.isRunning).toBe(true);
    });

    it('should track event history in debug mode', async () => {
      const debugEngine = new HermesEngine({ debug: true });
      await debugEngine.start();

      const event1 = createMockEvent(EventType.DM_RECEIVED);
      const event2 = createMockEvent(EventType.CHANNEL_MSG_RECEIVED);

      await debugEngine.emit(event1);
      await debugEngine.emit(event2);

      const history = debugEngine.getHistory();
      // +1 pour SYSTEM_READY émis au démarrage
      expect(history).toHaveLength(3);
      expect(history[1].id).toBe(event1.id);
      expect(history[2].id).toBe(event2.id);

      await debugEngine.stop();
    });

    it('should limit history size', async () => {
      const debugEngine = new HermesEngine({ debug: true });
      await debugEngine.start();

      // Emit more than 100 events to test the limit
      for (let i = 0; i < 105; i++) {
        await debugEngine.emit(createMockEvent(EventType.DM_RECEIVED));
      }

      const history = debugEngine.getHistory();
      expect(history.length).toBeLessThanOrEqual(100);

      await debugEngine.stop();
    });

    it('should respect history limit parameter', async () => {
      const debugEngine = new HermesEngine({ debug: true });
      await debugEngine.start();

      for (let i = 0; i < 10; i++) {
        await debugEngine.emit(createMockEvent(EventType.DM_RECEIVED));
      }

      const history = debugEngine.getHistory(5);
      expect(history).toHaveLength(5);

      await debugEngine.stop();
    });

    it('should not track history when not in debug mode', async () => {
      const nonDebugEngine = new HermesEngine({ debug: false });
      await nonDebugEngine.start();

      const event = createMockEvent(EventType.DM_RECEIVED);
      await nonDebugEngine.emit(event);

      expect(nonDebugEngine.getHistory()).toHaveLength(0);

      await nonDebugEngine.stop();
    });
  });
});
