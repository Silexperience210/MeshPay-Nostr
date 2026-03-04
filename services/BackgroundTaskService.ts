/**
 * Background Task Service — expo-background-fetch + expo-task-manager
 *
 * Tâches exécutées quand l'app est en arrière-plan ou fermée :
 *   1. BACKGROUND_MESSAGE_SYNC  — renvoie les messages en queue BLE offline
 *   2. BACKGROUND_CASHU_VERIFY  — vérifie les tokens Cashu non confirmés
 *   3. BACKGROUND_NOSTR_PRESENCE — republier la présence Nostr (radar)
 *
 * iOS  : nécessite Background App Refresh activé dans les réglages
 * Android : fonctionne via AlarmManager, intervalle minimum ~15 min
 */

import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { getPendingMessages, removePendingMessage, getUnverifiedCashuTokens, markCashuTokenVerified, incrementRetryCount } from '@/utils/database';
import { getBleGatewayClient } from '@/utils/ble-gateway';
import { verifyCashuToken } from '@/utils/cashu';

// ─── Noms des tâches ──────────────────────────────────────────────────────────
export const TASK_MESSAGE_SYNC    = 'meshpay-bg-message-sync';
export const TASK_CASHU_VERIFY    = 'meshpay-bg-cashu-verify';

// ─── Définition des tâches ───────────────────────────────────────────────────

/**
 * Tâche 1 : Sync messages BLE offline
 * Tente de renvoyer les paquets qui n'ont pas pu être transmis quand
 * la connexion BLE était coupée.
 */
TaskManager.defineTask(TASK_MESSAGE_SYNC, async () => {
  try {
    const pending = await getPendingMessages();
    if (pending.length === 0) {
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    const client = getBleGatewayClient();
    if (!client.isConnected()) {
      console.log('[BgTask] BLE non connecté — messages restent en queue');
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    let sent = 0;
    // Traiter au max 5 messages par cycle pour ne pas dépasser le temps alloué
    for (const msg of pending.slice(0, 5)) {
      try {
        await client.sendPacket(msg.packet as any);
        await removePendingMessage(msg.id);
        sent++;
      } catch {
        // Continuer avec le suivant
      }
    }

    console.log(`[BgTask] Message sync: ${sent}/${Math.min(pending.length, 5)} envoyés`);
    return sent > 0
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (err) {
    console.error('[BgTask] Message sync erreur:', err);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

/**
 * Tâche 2 : Vérification Cashu tokens non confirmés
 * Vérifie si les tokens reçus en DM ont été validés par le mint.
 */
TaskManager.defineTask(TASK_CASHU_VERIFY, async () => {
  try {
    const unverified = await getUnverifiedCashuTokens();
    const batch = unverified.filter(t => (t.retryCount ?? 0) < 10).slice(0, 3);

    if (batch.length === 0) {
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    let verified = 0;
    for (const token of batch) {
      try {
        const result = await verifyCashuToken(token.token);
        if (result.valid && !result.unverified) {
          await markCashuTokenVerified(token.id);
          verified++;
        } else {
          await incrementRetryCount(token.id);
        }
      } catch {
        await incrementRetryCount(token.id);
      }
    }

    console.log(`[BgTask] Cashu verify: ${verified}/${batch.length} vérifiés`);
    return verified > 0
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (err) {
    console.error('[BgTask] Cashu verify erreur:', err);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// ─── Enregistrement ──────────────────────────────────────────────────────────

/**
 * Enregistre toutes les tâches background.
 * À appeler une seule fois au démarrage de l'app (dans _layout.tsx ou App.tsx).
 */
export async function registerBackgroundTasks(): Promise<void> {
  try {
    // Tâche sync messages — toutes les 15 min (minimum Android)
    await BackgroundFetch.registerTaskAsync(TASK_MESSAGE_SYNC, {
      minimumInterval: 15 * 60, // secondes
      stopOnTerminate: false,   // continue quand l'app est tuée
      startOnBoot: true,        // relance au redémarrage du téléphone
    });

    // Tâche vérification Cashu — toutes les 30 min
    await BackgroundFetch.registerTaskAsync(TASK_CASHU_VERIFY, {
      minimumInterval: 30 * 60,
      stopOnTerminate: false,
      startOnBoot: false,
    });

    console.log('[BgTask] Tâches background enregistrées');
  } catch (err) {
    // Silencieux si déjà enregistré ou non supporté
    console.log('[BgTask] Enregistrement:', err instanceof Error ? err.message : err);
  }
}

/**
 * Désactive toutes les tâches background.
 * Utile si l'utilisateur désactive les notifications/background.
 */
export async function unregisterBackgroundTasks(): Promise<void> {
  try {
    await BackgroundFetch.unregisterTaskAsync(TASK_MESSAGE_SYNC);
    await BackgroundFetch.unregisterTaskAsync(TASK_CASHU_VERIFY);
    console.log('[BgTask] Tâches background désactivées');
  } catch { /* déjà désactivées */ }
}

/**
 * Retourne l'état des tâches background pour le debug.
 */
export async function getBackgroundTasksStatus(): Promise<{
  messageSync: BackgroundFetch.BackgroundFetchStatus | null;
  cashuVerify: BackgroundFetch.BackgroundFetchStatus | null;
}> {
  const [messageSync, cashuVerify] = await Promise.all([
    BackgroundFetch.getStatusAsync().catch(() => null),
    BackgroundFetch.getStatusAsync().catch(() => null),
  ]);
  return { messageSync, cashuVerify };
}
