/**
 * Tests unitaires pour EventStore
 * 
 * Couverture:
 * - Initialisation (création table + index)
 * - Sauvegarde d'événements (single + batch)
 * - Récupération d'événements (par ID, avec filtres)
 * - Statistiques
 * - Cleanup et maintenance
 * - Gestion des erreurs
 */

import { SQLiteEventStore, EventStore } from '../../core/EventStore';
import { HermesEvent, EventType, Transport } from '../../types';

// Mock functions (définies avant jest.mock pour éviter le hoisting)
const mockRunAsync = jest.fn();
const mockGetFirstAsync = jest.fn();
const mockGetAllAsync = jest.fn();
const mockExecAsync = jest.fn();
const mockWithTransactionAsync = jest.fn();
const mockCloseAsync = jest.fn();
const mockOpenDatabaseAsync = jest.fn();

// Mock expo-sqlite
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: (...args: any[]) => mockOpenDatabaseAsync(...args),
}));

describe('SQLiteEventStore', () => {
  let store: EventStore;

  const createMockEvent = (overrides: Partial<HermesEvent> = {}): HermesEvent => ({
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: EventType.DM_SENT,
    transport: Transport.NOSTR,
    timestamp: Date.now(),
    from: 'test-from',
    to: 'test-to',
    payload: { content: 'Hello', contentType: 'text' },
    meta: { originalId: 'nostr-123' },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup default mock implementations
    mockOpenDatabaseAsync.mockResolvedValue({
      runAsync: mockRunAsync,
      getFirstAsync: mockGetFirstAsync,
      getAllAsync: mockGetAllAsync,
      execAsync: mockExecAsync,
      withTransactionAsync: mockWithTransactionAsync,
      closeAsync: mockCloseAsync,
    });
    
    mockExecAsync.mockResolvedValue(undefined);
    mockRunAsync.mockResolvedValue({ changes: 1, lastInsertRowId: 1 });
    
    store = new SQLiteEventStore(':memory:');
  });

  afterEach(async () => {
    await store.close().catch(() => {});
  });

  // ─── Initialisation ─────────────────────────────────────────────────────────

  describe('init', () => {
    it('should create table and indexes on init', async () => {
      await store.init();

      expect(mockExecAsync).toHaveBeenCalledWith(
        expect.stringContaining('CREATE TABLE IF NOT EXISTS hermes_events')
      );
      expect(mockExecAsync).toHaveBeenCalledWith(
        expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_events_type')
      );
    });

    it('should not reinitialize if already initialized', async () => {
      await store.init();
      mockExecAsync.mockClear();

      await store.init();

      expect(mockExecAsync).not.toHaveBeenCalled();
    });

    it('should throw if database fails to open', async () => {
      mockOpenDatabaseAsync.mockRejectedValueOnce(new Error('DB Error'));

      await expect(store.init()).rejects.toThrow('EventStore init failed');
    });
  });

  // ─── Sauvegarde ─────────────────────────────────────────────────────────────

  describe('saveEvent', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should save a valid event', async () => {
      const event = createMockEvent();

      await store.saveEvent(event);

      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO hermes_events'),
        expect.arrayContaining([
          event.id,
          event.type,
          event.transport,
          event.timestamp,
          event.from,
          event.to,
          JSON.stringify(event.payload),
          JSON.stringify(event.meta),
        ])
      );
    });

    it('should throw if not initialized', async () => {
      const uninitializedStore = new SQLiteEventStore();
      const event = createMockEvent();

      await expect(uninitializedStore.saveEvent(event)).rejects.toThrow('EventStore not initialized');
    });

    it('should handle database errors', async () => {
      mockRunAsync.mockRejectedValueOnce(new Error('DB Error'));
      const event = createMockEvent();

      await expect(store.saveEvent(event)).rejects.toThrow('Failed to save event');
    });

    it('should handle events without meta', async () => {
      const event = createMockEvent({ meta: undefined as any });

      await store.saveEvent(event);

      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([JSON.stringify({})])
      );
    });
  });

  describe('saveEvents (batch)', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should save multiple events in transaction', async () => {
      const events = [
        createMockEvent({ id: 'event-1' }),
        createMockEvent({ id: 'event-2' }),
        createMockEvent({ id: 'event-3' }),
      ];

      await store.saveEvents(events);

      expect(mockWithTransactionAsync).toHaveBeenCalled();
    });

    it('should handle empty array', async () => {
      await store.saveEvents([]);

      expect(mockWithTransactionAsync).not.toHaveBeenCalled();
      expect(mockRunAsync).not.toHaveBeenCalled();
    });

    it('should rollback on error', async () => {
      mockWithTransactionAsync.mockImplementationOnce(async (fn: Function) => {
        // Simuler une transaction qui échoue
        throw new Error('Transaction failed');
      });

      const events = [createMockEvent(), createMockEvent()];

      await expect(store.saveEvents(events)).rejects.toThrow('Failed to save events batch');
    });

    it('should handle single event in batch', async () => {
      const events = [createMockEvent()];

      await store.saveEvents(events);

      expect(mockWithTransactionAsync).toHaveBeenCalled();
    });
  });

  // ─── Récupération ───────────────────────────────────────────────────────────

  describe('getEvent', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should return event by ID', async () => {
      const event = createMockEvent({ id: 'test-123' });
      mockGetFirstAsync.mockResolvedValueOnce({
        id: event.id,
        type: event.type,
        transport: event.transport,
        timestamp: event.timestamp,
        from_node: event.from,
        to_node: event.to,
        payload: JSON.stringify(event.payload),
        meta: JSON.stringify(event.meta),
      });

      const result = await store.getEvent('test-123');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('test-123');
      expect(result?.payload).toEqual(event.payload);
    });

    it('should return null for non-existent event', async () => {
      mockGetFirstAsync.mockResolvedValueOnce(null);

      const result = await store.getEvent('non-existent');

      expect(result).toBeNull();
    });

    it('should throw if not initialized', async () => {
      const uninitializedStore = new SQLiteEventStore();

      await expect(uninitializedStore.getEvent('test')).rejects.toThrow('EventStore not initialized');
    });
  });

  describe('getEvents', () => {
    beforeEach(async () => {
      await store.init();
    });

    const mockRows = [
      {
        id: 'event-1',
        type: EventType.DM_SENT,
        transport: Transport.NOSTR,
        timestamp: 1000,
        from_node: 'user-1',
        to_node: 'user-2',
        payload: '{"content":"hello"}',
        meta: '{}',
      },
      {
        id: 'event-2',
        type: EventType.DM_RECEIVED,
        transport: Transport.LORA,
        timestamp: 2000,
        from_node: 'user-2',
        to_node: 'user-1',
        payload: '{"content":"hi"}',
        meta: '{"hops":2}',
      },
    ];

    it('should return all events without filters', async () => {
      mockGetAllAsync.mockResolvedValueOnce(mockRows);

      const results = await store.getEvents();

      expect(results).toHaveLength(2);
      expect(mockGetAllAsync).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM hermes_events'),
        expect.any(Array)
      );
    });

    it('should filter by types', async () => {
      mockGetAllAsync.mockResolvedValueOnce([mockRows[0]]);

      await store.getEvents({ types: [EventType.DM_SENT] });

      expect(mockGetAllAsync).toHaveBeenCalledWith(
        expect.stringContaining('type IN (?)'),
        expect.arrayContaining([EventType.DM_SENT])
      );
    });

    it('should filter by transports', async () => {
      mockGetAllAsync.mockResolvedValueOnce([mockRows[0]]);

      await store.getEvents({ transports: [Transport.NOSTR] });

      expect(mockGetAllAsync).toHaveBeenCalledWith(
        expect.stringContaining('transport IN (?)'),
        expect.arrayContaining([Transport.NOSTR])
      );
    });

    it('should filter by from/to', async () => {
      mockGetAllAsync.mockResolvedValueOnce([mockRows[0]]);

      await store.getEvents({ from: 'user-1', to: 'user-2' });

      const callArgs = mockGetAllAsync.mock.calls[0];
      expect(callArgs[0]).toContain('from_node = ?');
      expect(callArgs[0]).toContain('to_node = ?');
      expect(callArgs[1]).toContain('user-1');
      expect(callArgs[1]).toContain('user-2');
    });

    it('should filter by time range', async () => {
      mockGetAllAsync.mockResolvedValueOnce([mockRows[1]]);

      await store.getEvents({ since: 1500, until: 2500 });

      const callArgs = mockGetAllAsync.mock.calls[0];
      expect(callArgs[0]).toContain('timestamp >= ?');
      expect(callArgs[0]).toContain('timestamp <= ?');
    });

    it('should apply limit and offset', async () => {
      mockGetAllAsync.mockResolvedValueOnce([mockRows[0]]);

      await store.getEvents({ limit: 10, offset: 5 });

      expect(mockGetAllAsync).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT ?'),
        expect.any(Array)
      );
    });

    it('should support different order options', async () => {
      mockGetAllAsync.mockResolvedValueOnce(mockRows);

      await store.getEvents({ orderBy: 'created_at', order: 'ASC' });

      expect(mockGetAllAsync).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY created_at ASC'),
        expect.any(Array)
      );
    });

    it('should parse JSON payload and meta', async () => {
      mockGetAllAsync.mockResolvedValueOnce(mockRows);

      const results = await store.getEvents();

      expect(results[0].payload).toEqual({ content: 'hello' });
      expect(results[1].meta).toEqual({ hops: 2 });
    });
  });

  // ─── Statistiques ───────────────────────────────────────────────────────────

  describe('getStats', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should return correct stats', async () => {
      mockGetFirstAsync.mockResolvedValueOnce({
        total: 100,
        oldest: 1000,
        newest: 9000,
      });

      mockGetAllAsync
        .mockResolvedValueOnce([
          { type: EventType.DM_SENT, count: 40 },
          { type: EventType.DM_RECEIVED, count: 60 },
        ])
        .mockResolvedValueOnce([
          { transport: Transport.NOSTR, count: 80 },
          { transport: Transport.LORA, count: 20 },
        ]);

      const stats = await store.getStats();

      expect(stats.totalEvents).toBe(100);
      expect(stats.eventsByType[EventType.DM_SENT]).toBe(40);
      expect(stats.eventsByType[EventType.DM_RECEIVED]).toBe(60);
      expect(stats.eventsByTransport[Transport.NOSTR]).toBe(80);
      expect(stats.eventsByTransport[Transport.LORA]).toBe(20);
      expect(stats.oldestEvent).toBe(1000);
      expect(stats.newestEvent).toBe(9000);
    });

    it('should handle empty database', async () => {
      mockGetFirstAsync.mockResolvedValueOnce({
        total: 0,
        oldest: null,
        newest: null,
      });
      mockGetAllAsync.mockResolvedValue([]);

      const stats = await store.getStats();

      expect(stats.totalEvents).toBe(0);
      expect(stats.oldestEvent).toBeNull();
      expect(stats.newestEvent).toBeNull();
    });
  });

  // ─── Maintenance ────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should delete events older than specified ms', async () => {
      const now = Date.now();
      const olderThanMs = 24 * 60 * 60 * 1000; // 1 day

      mockGetFirstAsync.mockResolvedValueOnce({ count: 50 });
      mockRunAsync.mockResolvedValueOnce({ changes: 50 });

      const deleted = await store.cleanup(olderThanMs);

      expect(deleted).toBe(50);
      expect(mockRunAsync).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM hermes_events WHERE timestamp < ?'),
        expect.any(Array)
      );
    });

    it('should return 0 if no events to delete', async () => {
      mockGetFirstAsync.mockResolvedValueOnce({ count: 0 });
      mockRunAsync.mockResolvedValueOnce({ changes: 0 });

      const deleted = await store.cleanup(1000);

      expect(deleted).toBe(0);
    });

    it('should throw if not initialized', async () => {
      const uninitializedStore = new SQLiteEventStore();

      await expect(uninitializedStore.cleanup(1000)).rejects.toThrow('EventStore not initialized');
    });
  });

  describe('clear', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should delete all events', async () => {
      await store.clear();

      expect(mockRunAsync).toHaveBeenCalledWith('DELETE FROM hermes_events');
    });

    it('should throw if not initialized', async () => {
      const uninitializedStore = new SQLiteEventStore();

      await expect(uninitializedStore.clear()).rejects.toThrow('EventStore not initialized');
    });
  });

  describe('close', () => {
    it('should close database connection', async () => {
      await store.init();
      await store.close();

      expect(mockCloseAsync).toHaveBeenCalled();
    });

    it('should handle multiple close calls gracefully', async () => {
      await store.init();
      await store.close();
      await store.close(); // Second close should not throw

      expect(mockCloseAsync).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Performance ────────────────────────────────────────────────────────────

  describe('performance', () => {
    beforeEach(async () => {
      await store.init();
    });

    it('should handle bulk insert of 1000 events efficiently', async () => {
      const events = Array.from({ length: 1000 }, (_, i) =>
        createMockEvent({
          id: `bulk-${i}`,
          timestamp: Date.now() + i,
        })
      );

      const start = Date.now();
      await store.saveEvents(events);
      const duration = Date.now() - start;

      expect(mockWithTransactionAsync).toHaveBeenCalled();
      // La transaction devrait être rapide (< 100ms mock)
      expect(duration).toBeLessThan(100);
    });
  });
});
