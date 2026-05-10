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
import BleManager from 'react-native-ble-manager';
import { getBleGatewayClient } from '@/utils/ble-gateway';
import { getPendingMessages, removePendingMessage, updateMessageStatusDB } from '@/utils/database';

// ✅ FIX: NotificationService n'existe pas — remplacé par des console.warn
const NotificationService = {
  sendLocalNotification: (title: string, body: string) => {
    console.warn('[BackgroundBLE] Notification (stub):', title, body);
  },
};

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

  /**
   * ✅ FIX: Définit la tâche background avant de l'enregistrer
   */
  async startBackgroundTask(taskName: string, taskFn: () => Promise<void>): Promise<void> {
    try {
      // ✅ FIX: Définir la tâche AVANT de l'enregistrer
      const TaskManager = await import('expo-task-manager');
      const BackgroundFetch = await import('expo-background-fetch');

      TaskManager.defineTask(taskName, taskFn);

      await BackgroundFetch.registerTaskAsync(taskName, {
        minimumInterval: 60,
        stopOnTerminate: false,
        startOnBoot: true,
      });
      console.log(`[BackgroundBLE] Tâche background enregistrée: ${taskName}`);
    } catch (error) {
      console.warn('[BackgroundBLE] Impossible d\'enregistrer la tâche background:', error);
    }
  }

  /**
   * ✅ FIX: Méthodes stub avec logging au lieu de throw
   */
  async enableBluetooth(): Promise<void> {
    console.warn('[BackgroundBLE] enableBluetooth() est un stub — implémentation native requise');
  }

  async disableBluetooth(): Promise<void> {
    console.warn('[BackgroundBLE] disableBluetooth() est un stub — implémentation native requise');
  }

  async scanForDevices(): Promise<void> {
    console.warn('[BackgroundBLE] scanForDevices() est un stub — implémentation native requise');
  }

  async connectToDevice(deviceId: string): Promise<void> {
    console.warn('[BackgroundBLE] connectToDevice() est un stub — implémentation native requise');
  }

  async disconnectDevice(): Promise<void> {
    console.warn('[BackgroundBLE] disconnectDevice() est un stub — implémentation native requise');
  }

  async readCharacteristic(serviceUUID: string, charUUID: string): Promise<Uint8Array | null> {
    console.warn('[BackgroundBLE] readCharacteristic() est un stub — implémentation native requise');
    return null;
  }

  async writeCharacteristic(serviceUUID: string, charUUID: string, data: Uint8Array): Promise<void> {
    console.warn('[BackgroundBLE] writeCharacteristic() est un stub — implémentation native requise');
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
          // ✅ Mettre à jour le statut du message en DB
          await updateMessageStatusDB(msg.id, 'sent').catch(() => {});
        } catch (err) {
          console.error('[BackgroundBLE] Échec envoi message:', msg.id, err);
          // ✅ Mettre à jour le statut en failed si max retries atteint ?
          // On laisse MessageRetryService gérer les retries et le statut final
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
