/**
 * Mock Nostr Client pour les tests d'intégration
 * Simule le comportement du nostr-client réel
 */

import type { NostrClient } from '@/utils/nostr-client';
import type { Event as NostrEvent } from 'nostr-tools';

export interface MockNostrClient extends NostrClient {
  // Propriétés
  isConnected: boolean;
  publicKey: string;
  relays: Array<{ url: string }>;
  
  // Méthodes de publication
  publishDMSealed: jest.Mock;
  publishChannelMessage: jest.Mock;
  publishTxRelay: jest.Mock;
  publish: jest.Mock;
  
  // Méthodes de souscription
  subscribeDMsSealed: jest.Mock;
  subscribeDMs: jest.Mock;
  subscribeChannel: jest.Mock;
  subscribeTxRelay: jest.Mock;
  
  // Utilitaires
  reconnect: jest.Mock;
  
  // Helpers pour les tests
  simulateIncomingDM: (from: string, content: string, event?: Partial<NostrEvent>) => void;
  simulateIncomingChannel: (nostrEvent: Partial<NostrEvent>) => void;
  simulateIncomingTxRelay: (payload: any, nostrEvent?: Partial<NostrEvent>) => void;
  simulateDisconnection: () => void;
  simulateReconnection: () => void;
  
  // Callbacks stockées pour simulation
  _dmCallbacks: Array<(from: string, content: string, event: NostrEvent) => void>;
  _channelCallbacks: Array<(event: NostrEvent) => void>;
  _txRelayCallbacks: Array<(payload: any, event: NostrEvent) => void>;
}

export const createMockNostrClient = (): MockNostrClient => {
  const mockClient = {
    // État
    isConnected: true,
    publicKey: 'mock-local-pubkey-hex-1234567890abcdef',
    relays: [
      { url: 'wss://relay.damus.io' },
      { url: 'wss://nos.lol' },
      { url: 'wss://relay.nostr.band' },
    ],
    
    // Callbacks stockées
    _dmCallbacks: [] as Array<(from: string, content: string, event: NostrEvent) => void>,
    _channelCallbacks: [] as Array<(event: NostrEvent) => void>,
    _txRelayCallbacks: [] as Array<(payload: any, event: NostrEvent) => void>,
    
    // Méthodes de publication
    publishDMSealed: jest.fn().mockImplementation((to: string, content: string) => {
      if (!mockClient.isConnected) {
        return Promise.reject(new Error('Not connected'));
      }
      const event: NostrEvent = {
        id: `dm-sealed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        pubkey: mockClient.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 14, // NIP-17
        tags: [['p', to]],
        content,
        sig: 'mock-sig',
      };
      return Promise.resolve(event);
    }),
    
    publishChannelMessage: jest.fn().mockImplementation((channelId: string, content: string) => {
      if (!mockClient.isConnected) {
        return Promise.reject(new Error('Not connected'));
      }
      const event: NostrEvent = {
        id: `channel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        pubkey: mockClient.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 42, // NIP-28
        tags: [['e', channelId, '', 'root']],
        content,
        sig: 'mock-sig',
      };
      return Promise.resolve(event);
    }),
    
    publishTxRelay: jest.fn().mockImplementation((payload: any) => {
      if (!mockClient.isConnected) {
        return Promise.reject(new Error('Not connected'));
      }
      const event: NostrEvent = {
        id: `txrelay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        pubkey: mockClient.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9001, // Custom
        tags: [],
        content: JSON.stringify(payload),
        sig: 'mock-sig',
      };
      return Promise.resolve(event);
    }),
    
    publish: jest.fn().mockImplementation((template: { kind: number; content: string; tags: string[][] }) => {
      if (!mockClient.isConnected) {
        return Promise.reject(new Error('Not connected'));
      }
      const event: NostrEvent = {
        id: `generic-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        pubkey: mockClient.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: template.kind,
        tags: template.tags,
        content: template.content,
        sig: 'mock-sig',
      };
      return Promise.resolve(event);
    }),
    
    // Méthodes de souscription
    subscribeDMsSealed: jest.fn().mockImplementation((callback: (from: string, content: string, event: NostrEvent) => void) => {
      mockClient._dmCallbacks.push(callback);
      // Retourner fonction de désinscription
      return () => {
        const idx = mockClient._dmCallbacks.indexOf(callback);
        if (idx > -1) mockClient._dmCallbacks.splice(idx, 1);
      };
    }),
    
    subscribeDMs: jest.fn().mockImplementation((callback: (from: string, content: string, event: NostrEvent) => void) => {
      mockClient._dmCallbacks.push(callback);
      return () => {
        const idx = mockClient._dmCallbacks.indexOf(callback);
        if (idx > -1) mockClient._dmCallbacks.splice(idx, 1);
      };
    }),
    
    subscribeChannel: jest.fn().mockImplementation((channelId: string, callback: (event: NostrEvent) => void) => {
      mockClient._channelCallbacks.push(callback);
      return () => {
        const idx = mockClient._channelCallbacks.indexOf(callback);
        if (idx > -1) mockClient._channelCallbacks.splice(idx, 1);
      };
    }),
    
    subscribeTxRelay: jest.fn().mockImplementation((callback: (payload: any, event: NostrEvent) => void) => {
      mockClient._txRelayCallbacks.push(callback);
      return () => {
        const idx = mockClient._txRelayCallbacks.indexOf(callback);
        if (idx > -1) mockClient._txRelayCallbacks.splice(idx, 1);
      };
    }),
    
    reconnect: jest.fn().mockImplementation(() => {
      mockClient.isConnected = true;
      return Promise.resolve();
    }),
    
    // Helpers pour les tests
    simulateIncomingDM: (from: string, content: string, event?: Partial<NostrEvent>) => {
      const fullEvent: NostrEvent = {
        id: event?.id || `incoming-dm-${Date.now()}`,
        pubkey: from,
        created_at: event?.created_at || Math.floor(Date.now() / 1000),
        kind: event?.kind || 14,
        tags: event?.tags || [['p', mockClient.publicKey]],
        content,
        sig: event?.sig || 'mock-sig',
      };
      mockClient._dmCallbacks.forEach(cb => cb(from, content, fullEvent));
    },
    
    simulateIncomingChannel: (nostrEvent: Partial<NostrEvent>) => {
      const fullEvent: NostrEvent = {
        id: nostrEvent.id || `incoming-channel-${Date.now()}`,
        pubkey: nostrEvent.pubkey || 'foreign-pubkey-hex',
        created_at: nostrEvent.created_at || Math.floor(Date.now() / 1000),
        kind: nostrEvent.kind || 42,
        tags: nostrEvent.tags || [['e', 'general', '', 'root']],
        content: nostrEvent.content || 'Hello channel!',
        sig: nostrEvent.sig || 'mock-sig',
      };
      mockClient._channelCallbacks.forEach(cb => cb(fullEvent));
    },
    
    simulateIncomingTxRelay: (payload: any, nostrEvent?: Partial<NostrEvent>) => {
      const fullEvent: NostrEvent = {
        id: nostrEvent?.id || `incoming-tx-${Date.now()}`,
        pubkey: nostrEvent?.pubkey || 'foreign-pubkey-hex',
        created_at: nostrEvent?.created_at || Math.floor(Date.now() / 1000),
        kind: nostrEvent?.kind || 9001,
        tags: nostrEvent?.tags || [],
        content: typeof payload === 'string' ? payload : JSON.stringify(payload),
        sig: nostrEvent?.sig || 'mock-sig',
      };
      mockClient._txRelayCallbacks.forEach(cb => cb(payload, fullEvent));
    },
    
    simulateDisconnection: () => {
      mockClient.isConnected = false;
    },
    
    simulateReconnection: () => {
      mockClient.isConnected = true;
    },
  };
  
  return mockClient as MockNostrClient;
};

/**
 * Crée un mock de NostrClient avec des valeurs personnalisées
 */
export const createMockNostrClientWithConfig = (config: {
  publicKey?: string;
  isConnected?: boolean;
  relays?: Array<{ url: string }>;
}): MockNostrClient => {
  const mock = createMockNostrClient();
  if (config.publicKey) mock.publicKey = config.publicKey;
  if (config.isConnected !== undefined) mock.isConnected = config.isConnected;
  if (config.relays) mock.relays = config.relays;
  return mock;
};

export default createMockNostrClient;
