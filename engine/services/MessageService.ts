/**
 * MessageService - Service de messagerie unifié basé sur Hermès Engine
 * 
 * Remplace complètement messaging-bus.ts (MessagingBus/MessagesProvider)
 * par une architecture pure Hermès avec Event Bus + Event Store.
 * 
 * Responsabilités:
 * - Envoi/réception de DMs et messages de channel
 * - Persistance via EventStore
 * - Bridge entre transports (Nostr ↔ LoRa)
 * - Historique des conversations
 */

import { hermes } from '../HermesEngine';
import { eventStore } from '../core/EventStore';
import {
  EventType,
  Transport,
  HermesEvent,
  MessageEvent,
} from '../types';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface DirectMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  transport: 'nostr' | 'lora';
  encryption?: 'nip04' | 'nip44';
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  from: string;
  content: string;
  timestamp: number;
  transport: 'nostr' | 'lora';
}

export interface MessageService {
  // ── Identity ──
  setIdentity(nodeId: string, pubkey: string): void;

  // ── Envoi ──
  sendDM(toNodeId: string, toPubkey: string, content: string): Promise<void>;
  sendChannelMessage(channelId: string, content: string): Promise<void>;

  // ── Réception ──
  onDM(handler: (msg: DirectMessage) => void): () => void;
  onChannelMessage(channelId: string, handler: (msg: ChannelMessage) => void): () => void;

  // ── Historique ──
  getDMHistory(peerId: string, limit?: number): Promise<DirectMessage[]>;
  getChannelHistory(channelId: string, limit?: number): Promise<ChannelMessage[]>;

  // ── Bridge ──
  bridgeToNostr(payload: string): Promise<void>;
  bridgeToLora(payload: string): Promise<void>;
}

// ─── Implémentation ─────────────────────────────────────────────────────────

export class MessageServiceImpl implements MessageService {
  private localNodeId = '';
  private localPubkey = '';

  setIdentity(nodeId: string, pubkey: string): void {
    this.localNodeId = nodeId;
    this.localPubkey = pubkey;
  }

  // ── Envoi ──────────────────────────────────────────────────────────────────

  async sendDM(toNodeId: string, toPubkey: string, content: string): Promise<void> {
    const timestamp = Date.now();
    const eventId = this.generateId();

    // 1. Persister dans EventStore (outbound)
    const event: HermesEvent = {
      id: eventId,
      type: EventType.DM_SENT,
      transport: Transport.NOSTR,
      timestamp,
      from: this.localNodeId,
      to: toNodeId,
      payload: {
        content,
        contentType: 'text',
        encryption: 'nip44',
        toPubkey,
      },
      meta: {
        encryption: 'nip44',
        originalId: eventId,
      },
    };

    await eventStore.save(event, 'outbound');

    // 2. Émettre via Hermès
    await hermes.emit(event, Transport.NOSTR);
  }

  async sendChannelMessage(channelId: string, content: string): Promise<void> {
    const timestamp = Date.now();
    const eventId = this.generateId();

    // 1. Persister dans EventStore (outbound)
    const event: HermesEvent = {
      id: eventId,
      type: EventType.CHANNEL_MSG_SENT,
      transport: Transport.NOSTR,
      timestamp,
      from: this.localNodeId,
      to: channelId,
      payload: {
        content,
        contentType: 'text',
        channelName: channelId,
      },
      meta: {
        originalId: eventId,
      },
    };

    await eventStore.save(event, 'outbound');

    // 2. Émettre via Hermès
    await hermes.emit(event, Transport.NOSTR);
  }

  // ── Réception ──────────────────────────────────────────────────────────────

  onDM(handler: (msg: DirectMessage) => void): () => void {
    return hermes.on(EventType.DM_RECEIVED, async (event: HermesEvent) => {
      // Persister en inbound
      await eventStore.save(event, 'inbound');

      const payload = event.payload as MessageEvent['payload'];

      // Dispatcher au handler
      handler({
        id: event.id,
        from: event.from,
        to: event.to,
        content: payload?.content ?? '',
        timestamp: event.timestamp,
        transport: event.transport as 'nostr' | 'lora',
        encryption: payload?.encryption,
      });
    });
  }

  onChannelMessage(channelId: string, handler: (msg: ChannelMessage) => void): () => void {
    return hermes.on(EventType.CHANNEL_MSG_RECEIVED, (event: HermesEvent) => {
      const payload = event.payload as MessageEvent['payload'];

      // Filtrer par channelId
      if (payload?.channelName !== channelId) {
        return;
      }

      handler({
        id: event.id,
        channelId,
        from: event.from,
        content: payload?.content ?? '',
        timestamp: event.timestamp,
        transport: event.transport as 'nostr' | 'lora',
      });
    });
  }

  // ── Historique ─────────────────────────────────────────────────────────────

  async getDMHistory(peerId: string, limit = 50): Promise<DirectMessage[]> {
    const events = await eventStore.getConversation(peerId, limit);

    return events
      .filter(
        e => e.type === EventType.DM_SENT || e.type === EventType.DM_RECEIVED
      )
      .map(e => {
        const payload = e.payload as MessageEvent['payload'];
        return {
          id: e.id,
          from: e.from,
          to: e.to,
          content: payload?.content ?? '',
          timestamp: e.timestamp,
          transport: e.transport as 'nostr' | 'lora',
          encryption: payload?.encryption,
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async getChannelHistory(channelId: string, limit = 50): Promise<ChannelMessage[]> {
    const events = await eventStore.getByType(EventType.CHANNEL_MSG_RECEIVED, limit);

    return events
      .filter(e => {
        const payload = e.payload as MessageEvent['payload'];
        return payload?.channelName === channelId;
      })
      .map(e => {
        const payload = e.payload as MessageEvent['payload'];
        return {
          id: e.id,
          channelId,
          from: e.from,
          content: payload?.content ?? '',
          timestamp: e.timestamp,
          transport: e.transport as 'nostr' | 'lora',
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  // ── Bridge ─────────────────────────────────────────────────────────────────

  async bridgeToNostr(payload: string): Promise<void> {
    await hermes.createEvent(
      EventType.BRIDGE_LORA_TO_NOSTR,
      {
        payload,
        originalTransport: Transport.LORA,
        targetTransport: Transport.NOSTR,
      },
      {
        transport: Transport.INTERNAL,
      }
    );
  }

  async bridgeToLora(payload: string): Promise<void> {
    await hermes.createEvent(
      EventType.BRIDGE_NOSTR_TO_LORA,
      {
        payload,
        originalTransport: Transport.NOSTR,
        targetTransport: Transport.LORA,
      },
      {
        transport: Transport.INTERNAL,
      }
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private generateId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const messageService: MessageService = new MessageServiceImpl();

// Export par défaut
export default messageService;
