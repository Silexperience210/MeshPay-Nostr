/**
 * Background BLE Service - Maintient la connexion BLE en arrière-plan
 *
 * Implémentation via setInterval (foreground polling) sans dépendances natives.
 * expo-background-task n'est pas compilé dans le build natif actuel (SDK 54).
 *
 * Fonctionnement :
 * - Foreground : polling toutes les POLL_INTERVAL_MS tant que l'app est active
 * - Background : l'OS peut suspendre l'app — les messages en attente sont
 *   persistés en SQLite et traités au retour en foreground.
 */

import { AppState, type AppStateStatus } from 'react-native';
import { getBleGatewayClient } from '@/utils/ble-gateway';
import { getPendingMessages, removePendingMessage } from '@/utils/database';

const POLL_INTERVAL_MS = 15_000;    // Toutes les 15 secondes en foreground
const MAX_MESSAGES_PER_CYCLE = 5;

class BackgroundBleService {
  private isRegistered = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

  async register(): Promise<void> {
    if (this.isRegistered) return;
    this.isRegistered = true;
    console.log('[BackgroundBLE] Service enregistré (polling foreground)');
  }

  async start(): Promise<void> {
    await this.register();

    // Polling continu en foreground
    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => {
        if (AppState.currentState === 'active') {
          this.processPendingMessages();
        }
      }, POLL_INTERVAL_MS);
    }

    // Traiter les messages dès le retour en foreground
    this.appStateSubscription = AppState.addEventListener(
      'change',
      (state: AppStateStatus) => {
        if (state === 'active') {
          this.processPendingMessages();
        }
      }
    );

    console.log('[BackgroundBLE] Démarré (intervalle: ' + POLL_INTERVAL_MS + 'ms)');
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    this.isRegistered = false;
    console.log('[BackgroundBLE] Arrêté');
  }

  async getStatus(): Promise<string> {
    return this.isRegistered ? 'registered' : 'unregistered';
  }

  async isTaskRegistered(): Promise<boolean> {
    return this.isRegistered;
  }

  async processPendingMessages(): Promise<void> {
    try {
      const client = getBleGatewayClient();
      if (!client.isConnected()) return;

      const pending = await getPendingMessages();
      if (pending.length === 0) return;

      console.log(`[BackgroundBLE] Traitement de ${pending.length} messages`);

      for (const msg of pending.slice(0, MAX_MESSAGES_PER_CYCLE)) {
        try {
          await client.sendRawPacket(msg.packet as Uint8Array);
          await removePendingMessage(msg.id);
        } catch {
          // Continuer avec le suivant
        }
      }
    } catch (error) {
      console.error('[BackgroundBLE] Erreur:', error);
    }
  }
}

// Singleton
let backgroundService: BackgroundBleService | null = null;

export function getBackgroundBleService(): BackgroundBleService {
  if (!backgroundService) {
    backgroundService = new BackgroundBleService();
  }
  return backgroundService;
}
