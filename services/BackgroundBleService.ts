/**
 * Background BLE Service - Maintient la connexion BLE en arrière-plan
 *
 * ✅ VERSION MIGRÉE : expo-background-task (SDK 53+)
 * Remplace l'ancienne version simplifiée sans expo-background-fetch
 *
 * INSTALLATION REQUISE :
 *   npx expo install expo-background-task expo-task-manager
 *
 * PERMISSIONS REQUISES dans app.json :
 *   iOS  → "UIBackgroundModes": ["fetch", "processing"]
 *   Android → pas de config supplémentaire nécessaire
 */

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { getBleGatewayClient } from '@/utils/ble-gateway';
import { getPendingMessages, removePendingMessage } from '@/utils/database';

// ─── Nom unique de la tâche ───────────────────────────────────────────────────
const BACKGROUND_BLE_TASK = 'meshpay-background-ble-sync';

// ─── Nombre max de messages traités par cycle background ──────────────────────
const MAX_MESSAGES_PER_CYCLE = 5;

// ─── Définition de la tâche (DOIT être en dehors de tout composant/classe) ────
TaskManager.defineTask(BACKGROUND_BLE_TASK, async () => {
  console.log('[BackgroundBLE] Tâche background déclenchée');

  try {
    const client = getBleGatewayClient();

    if (!client.isConnected()) {
      console.log('[BackgroundBLE] BLE non connecté, tâche ignorée');
      return BackgroundTask.BackgroundTaskResult.NoData;
    }

    const pending = await getPendingMessages();

    if (pending.length === 0) {
      console.log('[BackgroundBLE] Aucun message en attente');
      return BackgroundTask.BackgroundTaskResult.NoData;
    }

    console.log(`[BackgroundBLE] ${pending.length} messages à traiter`);

    let sentCount = 0;

    for (const msg of pending.slice(0, MAX_MESSAGES_PER_CYCLE)) {
      try {
        await client.sendPacket(msg.packet as any);
        await removePendingMessage(msg.id);
        sentCount++;
        console.log(`[BackgroundBLE] Message envoyé: ${msg.id}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[BackgroundBLE] Échec envoi ${msg.id}: ${errMsg}`);
        // On continue avec le suivant sans bloquer
      }
    }

    console.log(`[BackgroundBLE] Cycle terminé: ${sentCount}/${Math.min(pending.length, MAX_MESSAGES_PER_CYCLE)} envoyés`);
    return BackgroundTask.BackgroundTaskResult.Success;

  } catch (error) {
    console.error('[BackgroundBLE] Erreur tâche background:', error);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

// ─── Classe de gestion du service ─────────────────────────────────────────────
class BackgroundBleService {
  private isRegistered = false;

  /**
   * Enregistre la tâche background auprès du système OS
   * À appeler au démarrage de l'app (ex: dans _layout.tsx)
   *
   * Intervalle minimum :
   *   iOS     → 15 minutes (contrainte Apple, ignoré si inférieur)
   *   Android → configurable, 1 minute recommandé au minimum
   */
  async register(minimumIntervalSeconds: number = 60): Promise<void> {
    if (this.isRegistered) {
      console.log('[BackgroundBLE] Déjà enregistré');
      return;
    }

    try {
      // Vérifie si la tâche est déjà enregistrée côté OS
      const isAlreadyRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_BLE_TASK);

      if (!isAlreadyRegistered) {
        await BackgroundTask.registerTaskAsync(BACKGROUND_BLE_TASK, {
          minimumInterval: minimumIntervalSeconds,
        });
        console.log(`[BackgroundBLE] Tâche enregistrée (intervalle: ${minimumIntervalSeconds}s)`);
      } else {
        console.log('[BackgroundBLE] Tâche déjà enregistrée côté OS');
      }

      this.isRegistered = true;
    } catch (error) {
      console.error('[BackgroundBLE] Erreur enregistrement:', error);
      throw error;
    }
  }

  /**
   * Démarre le service (alias de register pour compatibilité avec l'ancienne API)
   */
  async start(minimumIntervalSeconds: number = 60): Promise<void> {
    await this.register(minimumIntervalSeconds);
    console.log('[BackgroundBLE] Démarré');
  }

  /**
   * Arrête et désenregistre la tâche background
   */
  async stop(): Promise<void> {
    try {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_BLE_TASK);

      if (isRegistered) {
        await BackgroundTask.unregisterTaskAsync(BACKGROUND_BLE_TASK);
        console.log('[BackgroundBLE] Tâche désenregistrée');
      }

      this.isRegistered = false;
      console.log('[BackgroundBLE] Arrêté');
    } catch (error) {
      console.error('[BackgroundBLE] Erreur arrêt:', error);
      throw error;
    }
  }

  /**
   * Retourne le statut courant de la tâche
   */
  async getStatus(): Promise<BackgroundTask.BackgroundTaskStatus | null> {
    try {
      return await BackgroundTask.getStatusAsync();
    } catch {
      return null;
    }
  }

  /**
   * Vérifie si la tâche est enregistrée côté OS
   */
  async isTaskRegistered(): Promise<boolean> {
    return TaskManager.isTaskRegisteredAsync(BACKGROUND_BLE_TASK);
  }

  /**
   * Traitement manuel des messages en attente
   * Utile quand l'app passe en foreground ou sur événement BLE
   */
  async processPendingMessages(): Promise<void> {
    try {
      const client = getBleGatewayClient();

      if (!client.isConnected()) {
        console.log('[BackgroundBLE] Non connecté, traitement manuel ignoré');
        return;
      }

      const pending = await getPendingMessages();
      if (pending.length === 0) return;

      console.log(`[BackgroundBLE] Traitement manuel: ${pending.length} messages`);

      for (const msg of pending.slice(0, MAX_MESSAGES_PER_CYCLE)) {
        try {
          await client.sendPacket(msg.packet as any);
          await removePendingMessage(msg.id);
        } catch {
          // Continuer avec le suivant
        }
      }
    } catch (error) {
      console.error('[BackgroundBLE] Erreur traitement manuel:', error);
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────
let backgroundService: BackgroundBleService | null = null;

export function getBackgroundBleService(): BackgroundBleService {
  if (!backgroundService) {
    backgroundService = new BackgroundBleService();
  }
  return backgroundService;
}
