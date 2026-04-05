/**
 * EventBuilder - Fluent API pour construire des événements Hermès
 * 
 * Exemple:
 * ```typescript
 * const event = EventBuilder.dm()
 *   .to('npub1abc...')
 *   .content('Hello!')
 *   .encrypt('nip17')
 *   .build();
 * 
 * await hermes.emit(event, Transport.NOSTR);
 * ```
 */

import { 
  HermesEvent, 
  EventType, 
  Transport, 
  MessageEvent,
  MessageDirection,
} from '../types';

let idCounter = 0;
const generateId = (): string => {
  return `${Date.now().toString(36)}-${(++idCounter).toString(36)}`;
};

export class EventBuilder {
  private event: Partial<HermesEvent> = {
    id: generateId(),
    timestamp: Date.now(),
    from: 'local',
    to: '*',
    meta: {},
  };

  static dm(): EventBuilder {
    const builder = new EventBuilder();
    builder.event.type = EventType.DM_SENT;
    return builder;
  }

  static channel(): EventBuilder {
    const builder = new EventBuilder();
    builder.event.type = EventType.CHANNEL_MSG_SENT;
    return builder;
  }

  static bridge(): EventBuilder {
    const builder = new EventBuilder();
    builder.event.type = EventType.BRIDGE_LORA_TO_NOSTR;
    return builder;
  }

  static system(): EventBuilder {
    const builder = new EventBuilder();
    builder.event.transport = Transport.INTERNAL;
    return builder;
  }

  static fromEvent(event: Partial<HermesEvent>): EventBuilder {
    const builder = new EventBuilder();
    builder.event = { ...builder.event, ...event };
    return builder;
  }

  // ─── Configuration ────────────────────────────────────────────────────────

  id(id: string): this {
    this.event.id = id;
    return this;
  }

  type(type: EventType): this {
    this.event.type = type;
    return this;
  }

  from(from: string): this {
    this.event.from = from;
    return this;
  }

  to(to: string): this {
    this.event.to = to;
    return this;
  }

  transport(transport: Transport): this {
    this.event.transport = transport;
    return this;
  }

  // ─── Payload spécifique ───────────────────────────────────────────────────

  content(content: string, contentType = 'text'): this {
    if (!this.event.payload) {
      this.event.payload = {};
    }
    (this.event.payload as any).content = content;
    (this.event.payload as any).contentType = contentType;
    return this;
  }

  channel(name: string): this {
    if (!this.event.payload) {
      this.event.payload = {};
    }
    (this.event.payload as any).channelName = name;
    return this;
  }

  encrypt(method: 'nip04' | 'nip44' | 'meshcore_aes'): this {
    if (!this.event.payload) {
      this.event.payload = {};
    }
    (this.event.payload as any).encryption = method;
    return this;
  }

  amount(sats: number): this {
    if (!this.event.payload) {
      this.event.payload = {};
    }
    (this.event.payload as any).amountSats = sats;
    return this;
  }

  raw(data: unknown): this {
    this.event.payload = data;
    return this;
  }

  // ─── Métadonnées ──────────────────────────────────────────────────────────

  meta(key: string, value: unknown): this {
    if (!this.event.meta) {
      this.event.meta = {};
    }
    (this.event.meta as any)[key] = value;
    return this;
  }

  originalId(id: string): this {
    return this.meta('originalId', id);
  }

  rtt(ms: number): this {
    return this.meta('rttMs', ms);
  }

  hops(count: number): this {
    return this.meta('hops', count);
  }

  // ─── Construction ─────────────────────────────────────────────────────────

  build(): HermesEvent {
    if (!this.event.type) {
      throw new Error('EventBuilder: type requis');
    }
    if (!this.event.payload) {
      this.event.payload = {};
    }
    
    return this.event as HermesEvent;
  }

  /**
   * Build et émettre immédiatement
   */
  async emit(engine: { emit: (e: HermesEvent, t?: Transport) => Promise<void> }, transport?: Transport): Promise<void> {
    await engine.emit(this.build(), transport);
  }
}

// Helper rapide
export const eb = () => new EventBuilder();
