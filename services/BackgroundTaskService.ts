/**
 * BackgroundTaskService — sync des messages BLE offline
 *
 * NOTE: expo-background-fetch / expo-task-manager sont incompatibles avec
 * expo-modules-core SDK 52 (méthode getAppContext manquante → crash natif).
 * Implémentation en-app : sync déclenché à la reconnexion BLE (voir BleProvider).
 *
 * Les tâches background système (TASK_MESSAGE_SYNC, TASK_CASHU_VERIFY) seront
 * réactivables dès que expo-task-manager sera compatible avec le SDK utilisé.
 */

import { getPendingMessages, removePendingMessage } from '@/utils/database';
import { getBleGatewayClient } from '@/utils/ble-gateway';

export const TASK_MESSAGE_SYNC = 'meshpay-bg-message-sync';
export const TASK_CASHU_VERIFY = 'meshpay-bg-cashu-verify';

/**
 * Tente de renvoyer les messages BLE en queue.
 * Appelé manuellement à la reconnexion BLE (BleProvider).
 */
export async function syncPendingMessages(): Promise<number> {
  try {
    const pending = await getPendingMessages();
    if (pending.length === 0) return 0;

    const client = getBleGatewayClient();
    if (!client.isConnected()) return 0;

    let sent = 0;
    for (const msg of pending.slice(0, 5)) {
      try {
        await client.sendPacket(msg.packet as any);
        await removePendingMessage(msg.id);
        sent++;
      } catch { /* continuer */ }
    }
    console.log(`[BgTask] Sync in-app: ${sent}/${Math.min(pending.length, 5)} messages envoyés`);
    return sent;
  } catch (err) {
    console.warn('[BgTask] syncPendingMessages:', err);
    return 0;
  }
}

/** No-op — conservé pour compatibilité des imports existants */
export async function registerBackgroundTasks(): Promise<void> {
  console.log('[BgTask] Background tasks désactivées (incompatibilité SDK 52)');
}

export async function unregisterBackgroundTasks(): Promise<void> {}

export async function getBackgroundTasksStatus() {
  return { messageSync: null, cashuVerify: null };
}
