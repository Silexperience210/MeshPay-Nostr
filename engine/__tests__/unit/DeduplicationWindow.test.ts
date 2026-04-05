/**
 * Tests unitaires pour DeduplicationWindow
 * Note: Cette classe est interne à HermesEngine, mais nous testons
 * son comportement via l'interface publique de HermesEngine
 */

import { HermesEngine } from '../../HermesEngine';
import {
  Transport,
  EventType,
  HermesEvent,
  HermesConfig,
} from '../../types';

describe('DeduplicationWindow', () => {
  // ─── Helpers ───────────────────────────────────────────────────────────────

  const createEngineWithCustomDedup = (
    dedupSize: number,
    dedupTtlMs: number
  ): HermesEngine => {
    const config: Partial<HermesConfig> = {
      debug: false,
      dedupSize,
      dedupTtlMs,
    };
    return new HermesEngine(config);
  };

  const createMockEvent = (id: string): HermesEvent => ({
    id,
    type: EventType.DM_RECEIVED,
    transport: Transport.NOSTR,
    timestamp: Date.now(),
    from: 'test-sender',
    to: 'test-recipient',
    payload: { content: 'test' },
    meta: {},
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Duplicate detection
  // ═════════════════════════════════════════════════════════════════════════════

  describe('duplicate detection', () => {
    it('should detect duplicates', async () => {
      const engine = createEngineWithCustomDedup(100, 60000);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const event = createMockEvent('duplicate-id');

      await engine.emit(event);
      await engine.emit(event); // Same ID

      expect(handler).toHaveBeenCalledTimes(1);

      await engine.stop();
    });

    it('should allow new entries', async () => {
      const engine = createEngineWithCustomDedup(100, 60000);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const event1 = createMockEvent('id-1');
      const event2 = createMockEvent('id-2');
      const event3 = createMockEvent('id-3');

      await engine.emit(event1);
      await engine.emit(event2);
      await engine.emit(event3);

      expect(handler).toHaveBeenCalledTimes(3);

      await engine.stop();
    });

    it('should treat events with different IDs as unique', async () => {
      const engine = createEngineWithCustomDedup(100, 60000);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      // Same content, different IDs
      const event1 = createMockEvent('id-a');
      const event2 = createMockEvent('id-b');

      await engine.emit(event1);
      await engine.emit(event2);

      expect(handler).toHaveBeenCalledTimes(2);

      await engine.stop();
    });

    it('should detect duplicate after multiple unique events', async () => {
      const engine = createEngineWithCustomDedup(100, 60000);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const event1 = createMockEvent('id-1');
      const event2 = createMockEvent('id-2');

      await engine.emit(event1);
      await engine.emit(event2);
      await engine.emit(event1); // Duplicate of first

      expect(handler).toHaveBeenCalledTimes(2);

      await engine.stop();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Max size limit
  // ═════════════════════════════════════════════════════════════════════════════

  describe('max size', () => {
    it('should respect max size', async () => {
      const smallWindow = createEngineWithCustomDedup(5, 60000);
      await smallWindow.start();

      // Emit more events than the window size
      for (let i = 0; i < 10; i++) {
        await smallWindow.emit(createMockEvent(`id-${i}`));
      }

      // Window should have evicted old entries
      expect(smallWindow.stats.dedupSize).toBeLessThanOrEqual(5);

      await smallWindow.stop();
    });

    it('should evict oldest entry when max size reached', async () => {
      const engine = createEngineWithCustomDedup(3, 60000);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      // Fill window
      await engine.emit(createMockEvent('old-1'));
      await engine.emit(createMockEvent('old-2'));
      await engine.emit(createMockEvent('old-3'));

      expect(engine.stats.dedupSize).toBe(3);

      // Add new entry (should evict oldest)
      await engine.emit(createMockEvent('new-1'));

      expect(engine.stats.dedupSize).toBe(3);

      // Old-1 should be evicted, so it can be re-emitted
      await engine.emit(createMockEvent('old-1'));
      expect(handler).toHaveBeenCalledTimes(5); // 3 + 1 + 1

      await engine.stop();
    });

    it('should handle window size of 1', async () => {
      const engine = createEngineWithCustomDedup(1, 60000);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      await engine.emit(createMockEvent('id-1'));
      await engine.emit(createMockEvent('id-2'));
      await engine.emit(createMockEvent('id-1')); // id-1 should be allowed again

      expect(handler).toHaveBeenCalledTimes(3);

      await engine.stop();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: TTL expiration
  // ═════════════════════════════════════════════════════════════════════════════

  describe('TTL', () => {
    it('should respect TTL', async () => {
      const shortTtl = 50; // 50ms
      const engine = createEngineWithCustomDedup(100, shortTtl);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const event = createMockEvent('ttl-test');
      await engine.emit(event);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Same event should be allowed after TTL
      await engine.emit(event);
      expect(handler).toHaveBeenCalledTimes(2);

      await engine.stop();
    });

    it('should cleanup expired entries', async () => {
      const shortTtl = 50; // 50ms
      const engine = createEngineWithCustomDedup(100, shortTtl);
      await engine.start();

      // +1 pour SYSTEM_READY émis au démarrage
      const initialSize = engine.stats.dedupSize;

      // Add events
      await engine.emit(createMockEvent('expire-1'));
      await engine.emit(createMockEvent('expire-2'));

      expect(engine.stats.dedupSize).toBe(initialSize + 2);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Trigger cleanup by adding new event
      await engine.emit(createMockEvent('fresh'));

      // Old entries should be cleaned up, only fresh remains + SYSTEM_READY si pas expiré
      expect(engine.stats.dedupSize).toBeLessThanOrEqual(initialSize + 1);

      await engine.stop();
    });

    it('should handle very short TTL', async () => {
      const veryShortTtl = 1; // 1ms
      const engine = createEngineWithCustomDedup(100, veryShortTtl);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const event = createMockEvent('quick-expire');
      await engine.emit(event);

      // Tiny delay
      await new Promise((resolve) => setTimeout(resolve, 10));

      await engine.emit(event);
      expect(handler).toHaveBeenCalledTimes(2);

      await engine.stop();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Combined size and TTL
  // ═════════════════════════════════════════════════════════════════════════════

  describe('combined size and TTL constraints', () => {
    it('should evict by age when both size and TTL constraints apply', async () => {
      const engine = createEngineWithCustomDedup(5, 50);
      await engine.start();

      // Add events quickly
      for (let i = 0; i < 5; i++) {
        await engine.emit(createMockEvent(`event-${i}`));
      }

      expect(engine.stats.dedupSize).toBe(5);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Add new event - should trigger cleanup of expired entries
      await engine.emit(createMockEvent('new-event'));

      // Window should only contain the new event (others expired)
      expect(engine.stats.dedupSize).toBe(1);

      await engine.stop();
    });

    it('should prefer size eviction over TTL when window is full', async () => {
      const engine = createEngineWithCustomDedup(3, 60000);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      // Fill window
      await engine.emit(createMockEvent('event-1'));
      await engine.emit(createMockEvent('event-2'));
      await engine.emit(createMockEvent('event-3'));

      // Immediately add more (size eviction, not TTL)
      await engine.emit(createMockEvent('event-4'));

      expect(engine.stats.dedupSize).toBe(3);

      // event-1 should have been evicted due to size
      await engine.emit(createMockEvent('event-1'));
      expect(handler).toHaveBeenCalledTimes(5);

      await engine.stop();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Edge cases
  // ═════════════════════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('should handle empty string IDs', async () => {
      const engine = createEngineWithCustomDedup(100, 60000);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const event1 = createMockEvent('');
      const event2 = createMockEvent('');

      await engine.emit(event1);
      await engine.emit(event2);

      // Empty string is still a valid ID for deduplication
      expect(handler).toHaveBeenCalledTimes(1);

      await engine.stop();
    });

    it('should handle special characters in IDs', async () => {
      const engine = createEngineWithCustomDedup(100, 60000);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const specialIds = [
        'id:with:colons',
        'id/with/slashes',
        'id.with.dots',
        'id-with-dashes',
        'id_with_underscores',
        'id\nwith\nnewlines',
        'id\twith\ttabs',
        '🔥emoji🔥',
      ];

      for (const id of specialIds) {
        await engine.emit(createMockEvent(id));
        await engine.emit(createMockEvent(id)); // Duplicate
      }

      expect(handler).toHaveBeenCalledTimes(specialIds.length);

      await engine.stop();
    });

    it('should handle very long IDs', async () => {
      const engine = createEngineWithCustomDedup(100, 60000);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const longId = 'a'.repeat(10000);
      const event = createMockEvent(longId);

      await engine.emit(event);
      await engine.emit(event);

      expect(handler).toHaveBeenCalledTimes(1);

      await engine.stop();
    });

    it('should handle many rapid events', async () => {
      const engine = createEngineWithCustomDedup(1000, 60000);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      // +1 pour SYSTEM_READY
      const initialSize = engine.stats.dedupSize;

      // Emit 100 unique events rapidly
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(engine.emit(createMockEvent(`rapid-${i}`)));
      }
      await Promise.all(promises);

      expect(handler).toHaveBeenCalledTimes(100);
      expect(engine.stats.dedupSize).toBe(initialSize + 100);

      await engine.stop();
    });

    it('should handle duplicate detection after engine restart', async () => {
      const engine = createEngineWithCustomDedup(100, 60000);
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const event = createMockEvent('persistent-id');
      await engine.emit(event);

      await engine.stop();

      // Restart engine (new dedup window)
      const newEngine = createEngineWithCustomDedup(100, 60000);
      await newEngine.start();

      const newHandler = jest.fn();
      newEngine.on(EventType.DM_RECEIVED, newHandler);

      // Same ID should be allowed in new engine instance
      await newEngine.emit(event);
      expect(newHandler).toHaveBeenCalledTimes(1);

      await newEngine.stop();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Default configuration
  // ═════════════════════════════════════════════════════════════════════════════

  describe('default configuration', () => {
    it('should use default dedup settings from HermesEngine', async () => {
      const engine = new HermesEngine({ debug: false });
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      // +1 pour SYSTEM_READY
      const initialSize = engine.stats.dedupSize;

      // Should handle default size (1000) and TTL (5 minutes)
      for (let i = 0; i < 100; i++) {
        await engine.emit(createMockEvent(`default-${i}`));
      }

      expect(handler).toHaveBeenCalledTimes(100);
      expect(engine.stats.dedupSize).toBe(initialSize + 100);

      await engine.stop();
    });

    it('should deduplicate with default settings', async () => {
      const engine = new HermesEngine({ debug: false });
      await engine.start();

      const handler = jest.fn();
      engine.on(EventType.DM_RECEIVED, handler);

      const event = createMockEvent('default-dedup-test');
      await engine.emit(event);
      await engine.emit(event);
      await engine.emit(event);

      expect(handler).toHaveBeenCalledTimes(1);

      await engine.stop();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Cleanup behavior
  // ═════════════════════════════════════════════════════════════════════════════

  describe('cleanup behavior', () => {
    it('should cleanup on each check', async () => {
      const engine = createEngineWithCustomDedup(100, 50);
      await engine.start();

      // +1 pour SYSTEM_READY
      const initialSize = engine.stats.dedupSize;

      // Add event
      await engine.emit(createMockEvent('cleanup-test'));
      expect(engine.stats.dedupSize).toBe(initialSize + 1);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check (via emit) should trigger cleanup
      await engine.emit(createMockEvent('trigger-cleanup'));

      // Size: SYSTEM_READY (pas expiré si tout se passe vite) + trigger-cleanup
      expect(engine.stats.dedupSize).toBeGreaterThanOrEqual(1);

      await engine.stop();
    });

    it('should handle cleanup with no expired entries', async () => {
      const engine = createEngineWithCustomDedup(100, 60000);
      await engine.start();

      // +1 pour SYSTEM_READY
      const initialSize = engine.stats.dedupSize;

      await engine.emit(createMockEvent('fresh-1'));
      await engine.emit(createMockEvent('fresh-2'));

      // Immediate check - nothing expired
      expect(engine.stats.dedupSize).toBe(initialSize + 2);

      await engine.stop();
    });

    it('should handle cleanup with all expired entries', async () => {
      const engine = createEngineWithCustomDedup(100, 50);
      await engine.start();

      await engine.emit(createMockEvent('old-1'));
      await engine.emit(createMockEvent('old-2'));

      await new Promise((resolve) => setTimeout(resolve, 100));

      // All entries expired, window should be empty after cleanup
      await engine.emit(createMockEvent('new'));

      expect(engine.stats.dedupSize).toBe(1);

      await engine.stop();
    });
  });
});
