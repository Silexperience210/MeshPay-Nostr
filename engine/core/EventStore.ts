/**
 * EventStore - Persistance des événements Hermès
 *
 * Stocke les événements entrants et sortants pour l'historique
 * des conversations et la reconstruction d'état.
 */

import { HermesEvent, EventType, Transport } from '../types';

export interface EventStoreFilter {
  types?: EventType[];
  transports?: Transport[];
  from?: string;
  to?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
  orderBy?: string;
  order?: 'ASC' | 'DESC';
}

export interface EventStoreStats {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsByTransport: Record<string, number>;
  oldestEvent: number | null;
  newestEvent: number | null;
}

export interface EventStore {
  init(): Promise<void>;
  save(event: HermesEvent, direction: 'inbound' | 'outbound'): Promise<void>;
  saveEvent(event: HermesEvent): Promise<void>;
  saveEvents(events: HermesEvent[]): Promise<void>;
  getEvent(id: string): Promise<HermesEvent | null>;
  getEvents(filter?: EventStoreFilter): Promise<HermesEvent[]>;
  getConversation(peerId: string, limit?: number): Promise<HermesEvent[]>;
  getByType(type: EventType, limit?: number): Promise<HermesEvent[]>;
  getStats(): Promise<EventStoreStats>;
  cleanup(olderThanMs: number): Promise<number>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

/**
 * SQLiteEventStore - Implémentation SQLite via expo-sqlite
 */
export class SQLiteEventStore implements EventStore {
  private db: any = null;
  private initialized = false;
  private dbPath: string;

  constructor(dbPath: string = 'hermes_events.db') {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const { openDatabaseAsync } = require('expo-sqlite');
      this.db = await openDatabaseAsync(this.dbPath);

      await this.db.execAsync(`
        CREATE TABLE IF NOT EXISTS hermes_events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          transport TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          from_node TEXT NOT NULL,
          to_node TEXT NOT NULL,
          payload TEXT NOT NULL,
          meta TEXT NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
        )
      `);

      await this.db.execAsync(
        'CREATE INDEX IF NOT EXISTS idx_events_type ON hermes_events(type)'
      );
      await this.db.execAsync(
        'CREATE INDEX IF NOT EXISTS idx_events_transport ON hermes_events(transport)'
      );
      await this.db.execAsync(
        'CREATE INDEX IF NOT EXISTS idx_events_timestamp ON hermes_events(timestamp)'
      );
      await this.db.execAsync(
        'CREATE INDEX IF NOT EXISTS idx_events_from ON hermes_events(from_node)'
      );
      await this.db.execAsync(
        'CREATE INDEX IF NOT EXISTS idx_events_to ON hermes_events(to_node)'
      );

      this.initialized = true;
    } catch (error: any) {
      throw new Error(`EventStore init failed: ${error.message}`);
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error('EventStore not initialized');
    }
  }

  async save(event: HermesEvent, _direction: 'inbound' | 'outbound'): Promise<void> {
    return this.saveEvent(event);
  }

  async saveEvent(event: HermesEvent): Promise<void> {
    this.ensureInitialized();
    try {
      await this.db.runAsync(
        'INSERT OR REPLACE INTO hermes_events (id, type, transport, timestamp, from_node, to_node, payload, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          event.id,
          event.type,
          event.transport,
          event.timestamp,
          event.from,
          event.to,
          JSON.stringify(event.payload),
          JSON.stringify(event.meta || {}),
        ]
      );
    } catch (error: any) {
      throw new Error(`Failed to save event: ${error.message}`);
    }
  }

  async saveEvents(events: HermesEvent[]): Promise<void> {
    if (events.length === 0) return;
    this.ensureInitialized();
    try {
      await this.db.withTransactionAsync(async () => {
        for (const event of events) {
          await this.db.runAsync(
            'INSERT OR REPLACE INTO hermes_events (id, type, transport, timestamp, from_node, to_node, payload, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              event.id,
              event.type,
              event.transport,
              event.timestamp,
              event.from,
              event.to,
              JSON.stringify(event.payload),
              JSON.stringify(event.meta || {}),
            ]
          );
        }
      });
    } catch (error: any) {
      throw new Error(`Failed to save events batch: ${error.message}`);
    }
  }

  async getEvent(id: string): Promise<HermesEvent | null> {
    this.ensureInitialized();
    const row = await this.db.getFirstAsync(
      'SELECT * FROM hermes_events WHERE id = ?',
      [id]
    );
    return row ? this.rowToEvent(row) : null;
  }

  async getEvents(filter: EventStoreFilter = {}): Promise<HermesEvent[]> {
    this.ensureInitialized();
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.types && filter.types.length > 0) {
      conditions.push(`type IN (${filter.types.map(() => '?').join(',')})`);
      params.push(...filter.types);
    }
    if (filter.transports && filter.transports.length > 0) {
      conditions.push(`transport IN (${filter.transports.map(() => '?').join(',')})`);
      params.push(...filter.transports);
    }
    if (filter.from) {
      conditions.push('from_node = ?');
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push('to_node = ?');
      params.push(filter.to);
    }
    if (filter.since != null) {
      conditions.push('timestamp >= ?');
      params.push(filter.since);
    }
    if (filter.until != null) {
      conditions.push('timestamp <= ?');
      params.push(filter.until);
    }

    const orderBy = filter.orderBy || 'timestamp';
    const order = filter.order || 'DESC';

    let sql = 'SELECT * FROM hermes_events';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ` ORDER BY ${orderBy} ${order}`;
    if (filter.limit != null) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    if (filter.offset != null) {
      sql += ' OFFSET ?';
      params.push(filter.offset);
    }

    const rows = await this.db.getAllAsync(sql, params);
    return rows.map((row: any) => this.rowToEvent(row));
  }

  async getConversation(peerId: string, limit = 50): Promise<HermesEvent[]> {
    return this.getEvents({
      from: peerId,
      to: peerId,
      limit,
    });
  }

  async getByType(type: EventType, limit = 50): Promise<HermesEvent[]> {
    return this.getEvents({ types: [type], limit });
  }

  async getStats(): Promise<EventStoreStats> {
    this.ensureInitialized();

    const summary = await this.db.getFirstAsync(
      'SELECT COUNT(*) as total, MIN(timestamp) as oldest, MAX(timestamp) as newest FROM hermes_events'
    );

    const typeRows = await this.db.getAllAsync(
      'SELECT type, COUNT(*) as count FROM hermes_events GROUP BY type'
    );
    const transportRows = await this.db.getAllAsync(
      'SELECT transport, COUNT(*) as count FROM hermes_events GROUP BY transport'
    );

    const eventsByType: Record<string, number> = {};
    for (const row of typeRows) {
      eventsByType[(row as any).type] = (row as any).count;
    }

    const eventsByTransport: Record<string, number> = {};
    for (const row of transportRows) {
      eventsByTransport[(row as any).transport] = (row as any).count;
    }

    return {
      totalEvents: summary.total,
      eventsByType,
      eventsByTransport,
      oldestEvent: summary.oldest ?? null,
      newestEvent: summary.newest ?? null,
    };
  }

  async cleanup(olderThanMs: number): Promise<number> {
    this.ensureInitialized();
    const cutoff = Date.now() - olderThanMs;
    const result = await this.db.runAsync(
      'DELETE FROM hermes_events WHERE timestamp < ?',
      [cutoff]
    );
    return result.changes;
  }

  async clear(): Promise<void> {
    this.ensureInitialized();
    await this.db.runAsync('DELETE FROM hermes_events');
  }

  async close(): Promise<void> {
    if (this.db && this.initialized) {
      await this.db.closeAsync();
      this.initialized = false;
      this.db = null;
    }
  }

  private rowToEvent(row: any): HermesEvent {
    return {
      id: row.id,
      type: row.type as EventType,
      transport: row.transport as Transport,
      timestamp: row.timestamp,
      from: row.from_node,
      to: row.to_node,
      payload: JSON.parse(row.payload),
      meta: JSON.parse(row.meta),
    };
  }
}

let _eventStore: EventStore | null = null;

export function getEventStore(): EventStore {
  if (!_eventStore) {
    _eventStore = new SQLiteEventStore();
  }
  return _eventStore;
}

export const eventStore: EventStore = new Proxy({} as EventStore, {
  get(_, prop) {
    return (getEventStore() as any)[prop];
  },
});
export default eventStore;
