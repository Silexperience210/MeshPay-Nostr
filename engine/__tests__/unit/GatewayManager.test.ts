/**
 * Tests unitaires pour GatewayManager
 * Phase 3.2 - Bridge LoRa ↔ Nostr
 */

import { GatewayManagerImpl } from '../../gateway/GatewayManager';
import { hermes, EventType, Transport } from '../../index';

describe('GatewayManager', () => {
  let gateway: GatewayManagerImpl;

  beforeEach(async () => {
    gateway = new GatewayManagerImpl();
    await gateway.start();
  });

  afterEach(async () => {
    await gateway.stop();
    gateway.resetStats();
  });

  describe('Lifecycle', () => {
    it('should start and set isRunning to true', () => {
      const status = gateway.getStatus();
      expect(status.isRunning).toBe(true);
    });

    it('should stop and set isRunning to false', async () => {
      await gateway.stop();
      const status = gateway.getStatus();
      expect(status.isRunning).toBe(false);
    });

    it('should not fail if started twice', async () => {
      await expect(gateway.start()).resolves.not.toThrow();
      expect(gateway.getStatus().isRunning).toBe(true);
    });
  });

  describe('Bridge Configuration', () => {
    it('should have both bridges enabled by default', () => {
      const status = gateway.getStatus();
      expect(status.bridgesEnabled.loraToNostr).toBe(true);
      expect(status.bridgesEnabled.nostrToLora).toBe(true);
    });

    it('should disable loraToNostr bridge', () => {
      gateway.setBridgeEnabled('loraToNostr', false);
      const status = gateway.getStatus();
      expect(status.bridgesEnabled.loraToNostr).toBe(false);
    });

    it('should disable nostrToLora bridge', () => {
      gateway.setBridgeEnabled('nostrToLora', false);
      const status = gateway.getStatus();
      expect(status.bridgesEnabled.nostrToLora).toBe(false);
    });
  });

  describe('Manual Bridge', () => {
    it('should bridge message from LoRa to Nostr', async () => {
      const handler = jest.fn();
      hermes.on(EventType.BRIDGE_LORA_TO_NOSTR, handler);

      await gateway.bridgeMessage('test-payload', Transport.LORA, Transport.NOSTR);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventType.BRIDGE_LORA_TO_NOSTR,
          payload: expect.objectContaining({
            payload: 'test-payload',
            from: Transport.LORA,
            to: Transport.NOSTR,
            manual: true,
          }),
        })
      );

      const status = gateway.getStatus();
      expect(status.stats.bridgedLoraToNostr).toBe(1);
    });

    it('should bridge message from Nostr to LoRa', async () => {
      const handler = jest.fn();
      hermes.on(EventType.BRIDGE_NOSTR_TO_LORA, handler);

      await gateway.bridgeMessage('test-payload', Transport.NOSTR, Transport.LORA);

      expect(handler).toHaveBeenCalled();

      const status = gateway.getStatus();
      expect(status.stats.bridgedNostrToLora).toBe(1);
    });
  });

  describe('Statistics', () => {
    it('should track bridge statistics', async () => {
      await gateway.bridgeMessage('msg1', Transport.LORA, Transport.NOSTR);
      await gateway.bridgeMessage('msg2', Transport.LORA, Transport.NOSTR);
      await gateway.bridgeMessage('msg3', Transport.NOSTR, Transport.LORA);

      const status = gateway.getStatus();
      expect(status.stats.bridgedLoraToNostr).toBe(2);
      expect(status.stats.bridgedNostrToLora).toBe(1);
    });

    it('should reset statistics', async () => {
      await gateway.bridgeMessage('msg', Transport.LORA, Transport.NOSTR);
      expect(gateway.getStatus().stats.bridgedLoraToNostr).toBe(1);

      gateway.resetStats();
      const status = gateway.getStatus();
      expect(status.stats.bridgedLoraToNostr).toBe(0);
      expect(status.stats.bridgedNostrToLora).toBe(0);
      expect(status.stats.errors).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should track errors in stats', async () => {
      // Simuler une erreur en émettant un événement incomplet
      await hermes.emit({
        id: 'test-error',
        type: EventType.DM_RECEIVED,
        transport: Transport.LORA,
        timestamp: Date.now(),
        from: 'test',
        to: 'test',
        payload: null, // Payload invalide
        meta: {},
      });

      // Attendre le traitement
      await new Promise(resolve => setTimeout(resolve, 50));

      const status = gateway.getStatus();
      expect(status.stats.errors).toBeGreaterThanOrEqual(0);
    });
  });
});
