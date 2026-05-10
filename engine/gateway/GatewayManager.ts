/**
 * GatewayManager - Bridge LoRa ↔ Nostr via Hermès Engine
 * 
 * Phase 3.2: Migration GatewayProvider vers handlers Hermès
 * Remplace le GatewayProvider legacy par un système event-sourced pur.
 */

import { hermes, EventType, Transport, type HermesEvent } from '../index';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GatewayStatus {
  isRunning: boolean;
  bridgesEnabled: {
    loraToNostr: boolean;
    nostrToLora: boolean;
  };
  stats: {
    bridgedLoraToNostr: number;
    bridgedNostrToLora: number;
    errors: number;
  };
}

export interface GatewayManager {
  /** Démarrer le gateway (subscribe aux événements) */
  start(): Promise<void>;
  
  /** Arrêter le gateway */
  stop(): Promise<void>;
  
  /** Statut du gateway */
  getStatus(): GatewayStatus;
  
  /** Forcer un bridge manuel */
  bridgeMessage(payload: string, from: Transport, to: Transport): Promise<void>;
  
  /** Activer/désactiver un bridge */
  setBridgeEnabled(direction: 'loraToNostr' | 'nostrToLora', enabled: boolean): void;
}

// ─── Implémentation ───────────────────────────────────────────────────────────

export class GatewayManagerImpl implements GatewayManager {
  private isRunning = false;
  private unsubscribers: Array<() => void> = [];
  private stats = {
    bridgedLoraToNostr: 0,
    bridgedNostrToLora: 0,
    errors: 0,
  };
  private bridgesEnabled = {
    loraToNostr: true,
    nostrToLora: true,
  };

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) return;

    // S'abonner aux messages LoRa entrants pour bridge vers Nostr
    const unsubLora = hermes.on(EventType.DM_RECEIVED, async (event) => {
      if (event.transport === Transport.LORA && this.bridgesEnabled.loraToNostr) {
        await this.handleLoraMessage(event);
      }
    });

    // S'abonner aux messages Nostr pour bridge vers LoRa (skip manual bridges)
    const unsubNostr = hermes.on(EventType.BRIDGE_NOSTR_TO_LORA, async (event) => {
      if (this.bridgesEnabled.nostrToLora && !(event.payload as any)?.manual) {
        await this.handleNostrBridgeEvent(event);
      }
    });

    // S'abonner aux channel messages LoRa pour bridge vers Nostr
    const unsubLoraChannel = hermes.on(EventType.CHANNEL_MSG_RECEIVED, async (event) => {
      if (event.transport === Transport.LORA && this.bridgesEnabled.loraToNostr) {
        await this.handleLoraChannelMessage(event);
      }
    });

    this.unsubscribers = [unsubLora, unsubNostr, unsubLoraChannel];
    this.isRunning = true;

    if (__DEV__) {
      console.log('[GatewayManager] Started');
    }
  }

  async stop(): Promise<void> {
    this.unsubscribers.forEach(unsub => unsub());
    this.unsubscribers = [];
    this.isRunning = false;

    if (__DEV__) {
      console.log('[GatewayManager] Stopped');
    }
  }

  // ─── Handlers ─────────────────────────────────────────────────────────────────

  private async handleLoraMessage(event: HermesEvent): Promise<void> {
    try {
      // Récupérer le contenu du payload
      const payload = event.payload as any;
      const content = payload?.content ?? String(payload);

      // Émettre l'événement de bridge
      await hermes.createEvent(
        EventType.BRIDGE_LORA_TO_NOSTR,
        {
          originalEvent: event,
          payload: content,
          from: event.from,
          to: event.to,
        },
        {
          transport: Transport.INTERNAL,
          meta: {
            originalId: event.id,
            bridgeTimestamp: Date.now(),
          },
        }
      );

      this.stats.bridgedLoraToNostr++;

      if (__DEV__) {
        console.log('[GatewayManager] Bridged LoRa→Nostr:', event.id);
      }
    } catch (error) {
      this.stats.errors++;
      console.error('[GatewayManager] Bridge LoRa→Nostr failed:', error);
    }
  }

  private async handleLoraChannelMessage(event: HermesEvent): Promise<void> {
    try {
      const payload = event.payload as any;
      
      await hermes.createEvent(
        EventType.BRIDGE_LORA_TO_NOSTR,
        {
          originalEvent: event,
          payload: payload?.content ?? '',
          channelName: payload?.channelName,
          from: event.from,
        },
        {
          transport: Transport.INTERNAL,
          meta: {
            originalId: event.id,
            isChannelMessage: true,
          },
        }
      );

      this.stats.bridgedLoraToNostr++;
    } catch (error) {
      this.stats.errors++;
      console.error('[GatewayManager] Bridge LoRa channel→Nostr failed:', error);
    }
  }

  private async handleNostrBridgeEvent(event: HermesEvent): Promise<void> {
    try {
      const payload = event.payload as any;
      
      // Émettre un événement pour le transport LoRa
      await hermes.createEvent(
        EventType.DM_SENT,
        {
          content: payload?.payload ?? '',
          contentType: 'text',
          bridgedFromNostr: true,
        },
        {
          transport: Transport.LORA,
          from: 'gateway',
          to: payload?.to ?? '*',
        }
      );

      this.stats.bridgedNostrToLora++;

      if (__DEV__) {
        console.log('[GatewayManager] Bridged Nostr→LoRa');
      }
    } catch (error) {
      this.stats.errors++;
      console.error('[GatewayManager] Bridge Nostr→LoRa failed:', error);
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  async bridgeMessage(payload: string, from: Transport, to: Transport): Promise<void> {
    const eventType = from === Transport.LORA 
      ? EventType.BRIDGE_LORA_TO_NOSTR 
      : EventType.BRIDGE_NOSTR_TO_LORA;

    await hermes.createEvent(
      eventType,
      { payload, from, to, manual: true },
      { transport: Transport.INTERNAL }
    );

    // Mettre à jour les stats
    if (from === Transport.LORA) {
      this.stats.bridgedLoraToNostr++;
    } else {
      this.stats.bridgedNostrToLora++;
    }
  }

  setBridgeEnabled(direction: 'loraToNostr' | 'nostrToLora', enabled: boolean): void {
    this.bridgesEnabled[direction] = enabled;
    
    if (__DEV__) {
      console.log(`[GatewayManager] Bridge ${direction} ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  getStatus(): GatewayStatus {
    return {
      isRunning: this.isRunning,
      bridgesEnabled: { ...this.bridgesEnabled },
      stats: { ...this.stats },
    };
  }

  /** Reset les statistiques (utile pour les tests) */
  resetStats(): void {
    this.stats = {
      bridgedLoraToNostr: 0,
      bridgedNostrToLora: 0,
      errors: 0,
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const gatewayManager = new GatewayManagerImpl();
