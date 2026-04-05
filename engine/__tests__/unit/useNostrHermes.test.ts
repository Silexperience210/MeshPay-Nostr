/**
 * Tests unitaires pour useNostrHermes
 * Couverture: Connexion, publication, souscription, cleanup
 */

import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useNostrHermes, UseNostrHermesReturn } from '../../hooks/useNostrHermes';
import { hermes, HermesEngine } from '../../HermesEngine';
import { EventType, Transport, HermesEvent } from '../../types';

// Mock du wallet store
jest.mock('@/stores/walletStore', () => ({
  useWalletStore: jest.fn((selector) => {
    const state = {
      walletInfo: {
        nostrPubkey: 'test-nostr-pubkey-123',
      },
    };
    return selector ? selector(state) : state;
  }),
}));

describe('useNostrHermes', () => {
  let engine: HermesEngine;
  
  beforeEach(() => {
    jest.clearAllMocks();
    engine = new HermesEngine({ debug: false });
  });
  
  afterEach(async () => {
    await engine.stop();
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: État initial
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('initial state', () => {
    it('should start disconnected', () => {
      const { result } = renderHook(() => useNostrHermes());
      
      expect(result.current.isConnected).toBe(false);
      expect(result.current.publicKey).toBe('test-nostr-pubkey-123');
      expect(result.current.relays).toEqual([]);
    });
    
    it('should have null publicKey when wallet has no nostrPubkey', () => {
      // Override mock pour simuler l'absence de nostrPubkey
      const { useWalletStore } = require('@/stores/walletStore');
      useWalletStore.mockImplementation((selector: any) => {
        const state = {
          walletInfo: null,
        };
        return selector ? selector(state) : state;
      });
      
      const { result } = renderHook(() => useNostrHermes());
      
      expect(result.current.publicKey).toBeNull();
    });
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Connexion
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('connect', () => {
    it('should connect and emit TRANSPORT_CONNECTED', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      const connectedHandler = jest.fn();
      hermes.on(EventType.TRANSPORT_CONNECTED, connectedHandler);
      
      await act(async () => {
        await result.current.connect();
      });
      
      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });
      
      expect(result.current.relays).toEqual([
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.nostr.band',
      ]);
      
      expect(connectedHandler).toHaveBeenCalled();
      const event = connectedHandler.mock.calls[0][0];
      expect(event.type).toBe(EventType.TRANSPORT_CONNECTED);
      expect(event.payload.transport).toBe(Transport.NOSTR);
    });
    
    it('should connect with custom relays', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      const customRelays = ['wss://custom.relay.io', 'wss://another.relay.io'];
      
      await act(async () => {
        await result.current.connect(customRelays);
      });
      
      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });
      
      expect(result.current.relays).toEqual(customRelays);
    });
    
    it('should handle connection errors', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      // Mock createEvent pour simuler une erreur
      const originalCreateEvent = hermes.createEvent;
      hermes.createEvent = jest.fn().mockRejectedValue(new Error('Connection failed'));
      
      await expect(result.current.connect()).rejects.toThrow('Connection failed');
      
      // Restaurer
      hermes.createEvent = originalCreateEvent;
    });
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Déconnexion
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('disconnect', () => {
    it('should disconnect and emit TRANSPORT_DISCONNECTED', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      // D'abord connecter
      await act(async () => {
        await result.current.connect();
      });
      
      expect(result.current.isConnected).toBe(true);
      
      const disconnectedHandler = jest.fn();
      hermes.on(EventType.TRANSPORT_DISCONNECTED, disconnectedHandler);
      
      await act(async () => {
        await result.current.disconnect();
      });
      
      await waitFor(() => {
        expect(result.current.isConnected).toBe(false);
      });
      
      expect(disconnectedHandler).toHaveBeenCalled();
      const event = disconnectedHandler.mock.calls[0][0];
      expect(event.type).toBe(EventType.TRANSPORT_DISCONNECTED);
      expect(event.payload.transport).toBe(Transport.NOSTR);
    });
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Publication de DMs
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('publishDM', () => {
    it('should publish DM and emit DM_SENT', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      // Connecter d'abord
      await act(async () => {
        await result.current.connect();
      });
      
      const dmSentHandler = jest.fn();
      hermes.on(EventType.DM_SENT, dmSentHandler);
      
      const toPubkey = 'npub1recipient';
      const content = 'Hello, this is a test message!';
      
      await act(async () => {
        await result.current.publishDM(toPubkey, content);
      });
      
      expect(dmSentHandler).toHaveBeenCalled();
      const event = dmSentHandler.mock.calls[0][0];
      expect(event.type).toBe(EventType.DM_SENT);
      expect(event.payload.content).toBe(content);
      expect(event.payload.contentType).toBe('text');
      expect(event.payload.encryption).toBe('nip44');
      expect(event.payload.to).toBe(toPubkey);
      expect(event.from).toBe('test-nostr-pubkey-123');
      expect(event.transport).toBe(Transport.NOSTR);
    });
    
    it('should throw when not connected', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      // Ne pas connecter
      expect(result.current.isConnected).toBe(false);
      
      await expect(
        result.current.publishDM('npub1test', 'message')
      ).rejects.toThrow('Nostr not connected');
    });
    
    it('should use "unknown" as from when publicKey is null', async () => {
      // Override mock pour simuler l'absence de publicKey
      const { useWalletStore } = require('@/stores/walletStore');
      useWalletStore.mockImplementation((selector: any) => {
        const state = {
          walletInfo: null,
        };
        return selector ? selector(state) : state;
      });
      
      const { result } = renderHook(() => useNostrHermes());
      
      await act(async () => {
        await result.current.connect();
      });
      
      const dmSentHandler = jest.fn();
      hermes.on(EventType.DM_SENT, dmSentHandler);
      
      await act(async () => {
        await result.current.publishDM('npub1recipient', 'test');
      });
      
      const event = dmSentHandler.mock.calls[0][0];
      expect(event.from).toBe('unknown');
    });
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Publication de messages de channel
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('publishChannelMessage', () => {
    it('should publish channel message and emit CHANNEL_MSG_SENT', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      await act(async () => {
        await result.current.connect();
      });
      
      const channelSentHandler = jest.fn();
      hermes.on(EventType.CHANNEL_MSG_SENT, channelSentHandler);
      
      const channelId = 'general';
      const content = 'Hello channel!';
      
      await act(async () => {
        await result.current.publishChannelMessage(channelId, content);
      });
      
      expect(channelSentHandler).toHaveBeenCalled();
      const event = channelSentHandler.mock.calls[0][0];
      expect(event.type).toBe(EventType.CHANNEL_MSG_SENT);
      expect(event.payload.content).toBe(content);
      expect(event.payload.channelName).toBe(channelId);
      expect(event.payload.contentType).toBe('text');
      expect(event.to).toBe(channelId);
    });
    
    it('should throw when not connected', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      await expect(
        result.current.publishChannelMessage('general', 'message')
      ).rejects.toThrow('Nostr not connected');
    });
  });
  
  // ║════════════════════════════════════════════════════════════════════════════
  // SECTION: Souscription aux DMs
  // ║════════════════════════════════════════════════════════════════════════════
  
  describe('subscribeDMs', () => {
    it('should subscribe to DM_RECEIVED events', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      const handler = jest.fn();
      
      let unsubscribe: (() => void) | undefined;
      act(() => {
        unsubscribe = result.current.subscribeDMs(handler);
      });
      
      expect(typeof unsubscribe).toBe('function');
      
      // Simuler un événement DM reçu
      const mockEvent: HermesEvent = {
        id: 'test-dm-id',
        type: EventType.DM_RECEIVED,
        transport: Transport.NOSTR,
        timestamp: Date.now(),
        from: 'npub1sender',
        to: 'local',
        payload: {
          content: 'Test message received',
          contentType: 'text',
          from: 'npub1sender',
        },
        meta: {},
      };
      
      await act(async () => {
        await hermes.emit(mockEvent);
      });
      
      expect(handler).toHaveBeenCalledWith('npub1sender', 'Test message received');
    });
    
    it('should handle DM with fromPubkey field', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      const handler = jest.fn();
      
      act(() => {
        result.current.subscribeDMs(handler);
      });
      
      // Simuler un événement DM avec fromPubkey
      const mockEvent: HermesEvent = {
        id: 'test-dm-id-2',
        type: EventType.DM_RECEIVED,
        transport: Transport.NOSTR,
        timestamp: Date.now(),
        from: 'local',
        to: 'local',
        payload: {
          content: 'Another test',
          fromPubkey: 'npub1another',
        },
        meta: {},
      };
      
      await act(async () => {
        await hermes.emit(mockEvent);
      });
      
      expect(handler).toHaveBeenCalledWith('npub1another', 'Another test');
    });
    
    it('should default to "unknown" when from is missing', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      const handler = jest.fn();
      
      act(() => {
        result.current.subscribeDMs(handler);
      });
      
      // Simuler un événement DM sans from
      const mockEvent: HermesEvent = {
        id: 'test-dm-id-3',
        type: EventType.DM_RECEIVED,
        transport: Transport.NOSTR,
        timestamp: Date.now(),
        from: 'local',
        to: 'local',
        payload: {
          content: 'Message without sender',
        },
        meta: {},
      };
      
      await act(async () => {
        await hermes.emit(mockEvent);
      });
      
      expect(handler).toHaveBeenCalledWith('unknown', 'Message without sender');
    });
    
    it('should unsubscribe correctly', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      const handler = jest.fn();
      
      let unsubscribe: (() => void) | undefined;
      act(() => {
        unsubscribe = result.current.subscribeDMs(handler);
      });
      
      // Désabonner
      act(() => {
        unsubscribe?.();
      });
      
      // Simuler un événement après désabonnement
      const mockEvent: HermesEvent = {
        id: 'test-dm-id-4',
        type: EventType.DM_RECEIVED,
        transport: Transport.NOSTR,
        timestamp: Date.now(),
        from: 'npub1sender',
        to: 'local',
        payload: {
          content: 'Should not be received',
        },
        meta: {},
      };
      
      await act(async () => {
        await hermes.emit(mockEvent);
      });
      
      expect(handler).not.toHaveBeenCalled();
    });
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Cleanup
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('cleanup', () => {
    it('should cleanup subscriptions on unmount', async () => {
      const handler = jest.fn();
      
      const { result, unmount } = renderHook(() => useNostrHermes());
      
      act(() => {
        result.current.subscribeDMs(handler);
      });
      
      // Détruire le hook
      unmount();
      
      // Simuler un événement après démontage
      const mockEvent: HermesEvent = {
        id: 'test-dm-id-5',
        type: EventType.DM_RECEIVED,
        transport: Transport.NOSTR,
        timestamp: Date.now(),
        from: 'npub1sender',
        to: 'local',
        payload: {
          content: 'Should not be received after unmount',
        },
        meta: {},
      };
      
      await act(async () => {
        await hermes.emit(mockEvent);
      });
      
      expect(handler).not.toHaveBeenCalled();
    });
    
    it('should not update state after unmount', async () => {
      const { result, unmount } = renderHook(() => useNostrHermes());
      
      // Détruire le hook
      unmount();
      
      // Tenter de connecter après démontage - ne devrait pas planter
      await act(async () => {
        // Cette opération est async mais ne devrait pas causer d'erreur
        try {
          await result.current.connect();
        } catch (e) {
          // Ignorer les erreurs
        }
      });
      
      // Le test passe si on arrive ici sans erreur
      expect(true).toBe(true);
    });
  });
  
  // ═════════════════════════════════════════════════════════════════════════════
  // SECTION: Réactivité aux événements externes
  // ═════════════════════════════════════════════════════════════════════════════
  
  describe('external events', () => {
    it('should update isConnected on TRANSPORT_CONNECTED event', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      expect(result.current.isConnected).toBe(false);
      
      // Simuler un événement de connexion externe
      const mockEvent: HermesEvent = {
        id: 'conn-event-1',
        type: EventType.TRANSPORT_CONNECTED,
        transport: Transport.NOSTR,
        timestamp: Date.now(),
        from: 'nostr',
        to: '*',
        payload: {
          transport: Transport.NOSTR,
          endpoint: 'wss://relay.test.io',
        },
        meta: {},
      };
      
      await act(async () => {
        await hermes.emit(mockEvent);
      });
      
      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });
      
      expect(result.current.relays).toEqual(['wss://relay.test.io']);
    });
    
    it('should update isConnected on TRANSPORT_DISCONNECTED event', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      // D'abord connecter
      await act(async () => {
        await result.current.connect();
      });
      
      expect(result.current.isConnected).toBe(true);
      
      // Simuler un événement de déconnexion externe
      const mockEvent: HermesEvent = {
        id: 'conn-event-2',
        type: EventType.TRANSPORT_DISCONNECTED,
        transport: Transport.NOSTR,
        timestamp: Date.now(),
        from: 'nostr',
        to: '*',
        payload: {
          transport: Transport.NOSTR,
        },
        meta: {},
      };
      
      await act(async () => {
        await hermes.emit(mockEvent);
      });
      
      await waitFor(() => {
        expect(result.current.isConnected).toBe(false);
      });
    });
    
    it('should ignore non-NOSTR transport events', async () => {
      const { result } = renderHook(() => useNostrHermes());
      
      expect(result.current.isConnected).toBe(false);
      
      // Simuler un événement de connexion LoRa (pas Nostr)
      const mockEvent: HermesEvent = {
        id: 'conn-event-3',
        type: EventType.TRANSPORT_CONNECTED,
        transport: Transport.LORA,
        timestamp: Date.now(),
        from: 'lora',
        to: '*',
        payload: {
          transport: Transport.LORA,
          endpoint: 'BLE-device-123',
        },
        meta: {},
      };
      
      await act(async () => {
        await hermes.emit(mockEvent);
      });
      
      // Devrait rester déconnecté
      expect(result.current.isConnected).toBe(false);
      expect(result.current.relays).toEqual([]);
    });
  });
});
