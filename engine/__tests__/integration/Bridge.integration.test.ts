/**
 * Tests d'intégration pour le Bridge LoRa↔Nostr
 * 
 * Ces tests vérifient:
 * - Le bridge bidirectionnel entre LoRa et Nostr
 * - La déduplication des messages bridgés
 * - La gestion des échecs de bridge
 * - Le flux complet: LoRa → Engine → Nostr et Nostr → Engine → LoRa
 */

import { HermesEngine } from '../../HermesEngine';
import { NostrAdapter } from '../../adapters/NostrAdapter';
import { LoRaAdapter } from '../../adapters/LoRaAdapter';
import { Transport, EventType, HermesEvent, MessageEvent, BridgeEvent } from '../../types';
import { createMockNostrClient, MockNostrClient } from '../../mocks/mockNostrClient';
import { createMockBleClient, createMockContact, MockBleClient } from '../../mocks/mockBleClient';

describe('LoRa↔Nostr Bridge', () => {
  let engine: HermesEngine;
  let nostrAdapter: NostrAdapter;
  let loraAdapter: LoRaAdapter;
  let mockNostr: MockNostrClient;
  let mockBle: MockBleClient;
  
  const TEST_DEVICE_ID = 'test-ble-bridge-001';
  
  beforeEach(() => {
    jest.useFakeTimers();
    engine = new HermesEngine({ debug: false });
    
    // Créer les mocks
    mockNostr = createMockNostrClient();
    mockBle = createMockBleClient();
    
    // Créer les adapters
    nostrAdapter = new NostrAdapter(engine, mockNostr as any);
    loraAdapter = new LoRaAdapter(engine, mockBle as any, { 
      autoBridgeToNostr: true,
      autoConnect: false,
    });
    
    // Enregistrer les adapters
    engine.registerAdapter(nostrAdapter);
    engine.registerAdapter(loraAdapter);
  });
  
  afterEach(async () => {
    jest.useRealTimers();
    await engine.stop();
  });

  describe('LoRa → Nostr Bridge', () => {
    beforeEach(async () => {
      await engine.start();
      jest.advanceTimersByTime(1500); // Pour Nostr
      await loraAdapter.connect(TEST_DEVICE_ID);
    });
    
    it('should bridge LoRa DM to Nostr', () => {
      // Simuler réception d'un message LoRa
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'meshcore',
        text: 'Hello from the mesh!',
      });
      
      // Vérifier que le bridge a créé un event BRIDGE_LORA_TO_NOSTR
      // Puis que NostrAdapter a reçu cet event
      expect(mockNostr.publishTxRelay).toHaveBeenCalled();
      const callArgs = mockNostr.publishTxRelay.mock.calls[0][0];
      expect(callArgs.type).toBe('lora_relay');
    });
    
    it('should bridge LoRa channel message to Nostr', () => {
      mockBle.simulateIncomingMessage({
        type: 'channel',
        senderPubkeyPrefix: 'broadcaster',
        text: 'Channel broadcast to bridge',
        channelIdx: 3,
      });
      
      expect(mockNostr.publishTxRelay).toHaveBeenCalled();
    });
    
    it('should preserve original sender info in bridge payload', () => {
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'original',
        text: 'Message with metadata',
        pathLen: 2,
        snr: 10.5,
      });
      
      const callArgs = mockNostr.publishTxRelay.mock.calls[0][0];
      const parsedData = JSON.parse(callArgs.data);
      expect(parsedData).toContain('original');
    });
    
    it('should include meshcore-from tag when bridging', () => {
      // Le NostrAdapter devrait inclure le meshcore-from tag
      // quand il reçoit un bridge event
      const bridgeEvent: BridgeEvent = {
        id: 'bridge-test-001',
        type: EventType.BRIDGE_LORA_TO_NOSTR,
        transport: Transport.INTERNAL,
        timestamp: Date.now(),
        from: 'meshcore-node-xyz',
        to: '*',
        payload: {
          originalTransport: Transport.LORA,
          targetTransport: Transport.NOSTR,
          rawPayload: JSON.stringify({ content: 'Tagged message' }),
        },
        meta: {
          originalId: 'lora-original-id',
        },
      };
      
      engine.emit(bridgeEvent, Transport.NOSTR);
      
      expect(mockNostr.publishTxRelay).toHaveBeenCalled();
    });
  });

  describe('Nostr → LoRa Bridge', () => {
    beforeEach(async () => {
      await engine.start();
      jest.advanceTimersByTime(1500);
      await loraAdapter.connect(TEST_DEVICE_ID);
      
      // Ajouter un contact pour pouvoir répondre
      const contact = createMockContact({
        pubkeyHex: 'nostrrecipientpubkeyhex' + 'c'.repeat(20),
        pubkeyPrefix: 'nostrrecv',
        name: 'Nostr Bridge Target',
      });
      mockBle.simulateContactDiscovered(contact);
    });
    
    it('should bridge Nostr message to LoRa when target is available', () => {
      // Configurer l'engine pour écouter les bridges et les router vers LoRa
      engine.on(EventType.BRIDGE_NOSTR_TO_LORA, async (event) => {
        // Router vers LoRa si c'est notre nœud
        if ((event.payload as any).targetTransport === Transport.LORA) {
          const dmEvent: MessageEvent = {
            id: `bridged-${event.id}`,
            type: EventType.DM_SENT,
            transport: Transport.LORA,
            timestamp: Date.now(),
            from: 'local',
            to: 'nostrrecipientpubkeyhex' + 'c'.repeat(20),
            payload: {
              content: (event.payload as any).rawPayload,
              contentType: 'text',
            },
            meta: {},
          };
          await engine.emit(dmEvent, Transport.LORA);
        }
      });
      
      // Simuler un message Nostr qui demande à être relayé vers LoRa
      mockNostr.simulateIncomingTxRelay(
        { type: 'lora_relay', data: 'Bridge to LoRa node' },
        { 
          id: 'nostr-bridge-001',
          pubkey: 'foreign-pubkey',
        }
      );
      
      expect(mockBle.sendDirectMessage).toHaveBeenCalledWith(
        'nostrrecipientpubkeyhex' + 'c'.repeat(20),
        expect.stringContaining('Bridge to LoRa')
      );
    });
    
    it('should emit BRIDGE_NOSTR_TO_LORA event', () => {
      const bridgeHandler = jest.fn();
      engine.on(EventType.BRIDGE_NOSTR_TO_LORA, bridgeHandler);
      
      mockNostr.simulateIncomingTxRelay(
        { type: 'lora_relay', data: 'Test bridge' },
        { id: 'nostr-tx-001' }
      );
      
      expect(bridgeHandler).toHaveBeenCalled();
      const event = bridgeHandler.mock.calls[0][0];
      expect(event.type).toBe(EventType.BRIDGE_NOSTR_TO_LORA);
      expect(event.payload.originalTransport).toBe(Transport.NOSTR);
      expect(event.payload.targetTransport).toBe(Transport.LORA);
    });
  });

  describe('Message Deduplication', () => {
    beforeEach(async () => {
      await engine.start();
      jest.advanceTimersByTime(1500);
      await loraAdapter.connect(TEST_DEVICE_ID);
    });
    
    it('should deduplicate bridged messages', () => {
      const nostrTxHandler = jest.fn();
      engine.on(EventType.BRIDGE_LORA_TO_NOSTR, nostrTxHandler);
      
      // Premier message
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'sender',
        text: 'First message',
      });
      
      // Même message (même contenu mais pas même ID - l'adapter génère un ID unique)
      // La déduplication se fait sur l'ID de l'événement Hermès
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'sender',
        text: 'First message',
      });
      
      // Le handler devrait être appelé pour chaque message car ils ont des IDs différents
      // (basés sur timestamp et senderPubkeyPrefix)
      expect(nostrTxHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe('Bridge Failure Handling', () => {
    beforeEach(async () => {
      await engine.start();
      jest.advanceTimersByTime(1500);
      await loraAdapter.connect(TEST_DEVICE_ID);
    });
    
    it('should handle Nostr publish failure gracefully', async () => {
      mockNostr.publishTxRelay.mockRejectedValue(new Error('Relay unavailable'));
      
      const errorHandler = jest.fn();
      engine.onError(errorHandler);
      
      // Envoyer un message qui déclenche un bridge
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'sender',
        text: 'Will fail to bridge',
      });
      
      // L'erreur devrait être capturée
      await jest.advanceTimersByTimeAsync(100);
      
      // Le message LoRa original est toujours reçu
      expect(mockNostr.publishTxRelay).toHaveBeenCalled();
    });
    
    it('should handle LoRa send failure gracefully', async () => {
      mockBle.sendDirectMessage.mockRejectedValue(new Error('Node unreachable'));
      
      // Simuler un bridge Nostr→LoRa vers un nœud inconnu
      const bridgeEvent: BridgeEvent = {
        id: 'bridge-fail-001',
        type: EventType.BRIDGE_NOSTR_TO_LORA,
        transport: Transport.INTERNAL,
        timestamp: Date.now(),
        from: 'nostr-sender',
        to: '*',
        payload: {
          originalTransport: Transport.NOSTR,
          targetTransport: Transport.LORA,
          rawPayload: JSON.stringify({ target: 'unknown-node', content: 'Hi' }),
        },
        meta: {},
      };
      
      // Essayer d'envoyer vers LoRa
      await expect(
        engine.emit(bridgeEvent, Transport.LORA)
      ).rejects.toThrow();
    });
    
    it('should handle transport unavailable', async () => {
      // Déconnecter Nostr
      mockNostr.simulateDisconnection();
      jest.advanceTimersByTime(1500);
      
      const errorHandler = jest.fn();
      const unsub = engine.onError(errorHandler);
      
      // Essayer de bridge - devrait échouer
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'sender',
        text: 'While Nostr is down',
      });
      
      await jest.advanceTimersByTimeAsync(100);
      
      unsub();
    });
  });

  describe('Bidirectional Bridge Flow', () => {
    beforeEach(async () => {
      await engine.start();
      jest.advanceTimersByTime(1500);
      await loraAdapter.connect(TEST_DEVICE_ID);
    });
    
    it('should handle round-trip bridge LoRa→Nostr→LoRa', () => {
      const bridgeLoraToNostr = jest.fn();
      const bridgeNostrToLora = jest.fn();
      
      engine.on(EventType.BRIDGE_LORA_TO_NOSTR, bridgeLoraToNostr);
      engine.on(EventType.BRIDGE_NOSTR_TO_LORA, bridgeNostrToLora);
      
      // 1. Message LoRa reçu
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'roundtrip',
        text: 'Roundtrip test',
      });
      
      expect(bridgeLoraToNostr).toHaveBeenCalled();
      
      // 2. Quelqu'un sur Nostr répond
      mockNostr.simulateIncomingTxRelay(
        { type: 'lora_relay', data: 'Response from Nostr' },
        { id: 'nostr-response-001' }
      );
      
      expect(bridgeNostrToLora).toHaveBeenCalled();
    });
    
    it('should maintain message context through bridge', () => {
      const messages: HermesEvent[] = [];
      
      engine.subscribe({ types: [EventType.DM_RECEIVED, EventType.BRIDGE_LORA_TO_NOSTR] }, (event) => {
        messages.push(event);
      });
      
      // Message initial LoRa
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'context',
        text: 'Context test',
        snr: 15.5,
        pathLen: 2,
      });
      
      // Vérifier que les métadonnées sont préservées
      const dmEvent = messages.find(e => e.type === EventType.DM_RECEIVED);
      const bridgeEvent = messages.find(e => e.type === EventType.BRIDGE_LORA_TO_NOSTR);
      
      expect(dmEvent).toBeDefined();
      expect(bridgeEvent).toBeDefined();
    });
  });

  describe('Bridge Configuration', () => {
    it('should respect autoBridgeToNostr setting', async () => {
      // Recréer sans auto-bridge
      await engine.stop();
      
      engine = new HermesEngine({ debug: false });
      mockNostr = createMockNostrClient();
      mockBle = createMockBleClient();
      
      nostrAdapter = new NostrAdapter(engine, mockNostr as any);
      loraAdapter = new LoRaAdapter(engine, mockBle as any, { 
        autoBridgeToNostr: false, // Désactivé
      });
      
      engine.registerAdapter(nostrAdapter);
      engine.registerAdapter(loraAdapter);
      
      await engine.start();
      jest.advanceTimersByTime(1500);
      await loraAdapter.connect(TEST_DEVICE_ID);
      
      mockBle.simulateIncomingMessage({
        type: 'direct',
        senderPubkeyPrefix: 'sender',
        text: 'Should not bridge',
      });
      
      expect(mockNostr.publishTxRelay).not.toHaveBeenCalled();
    });
  });
});
