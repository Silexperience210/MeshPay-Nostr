/**
 * Services Index - Exporte tous les services
 */

export { getMessageRetryService, initMessageRetryService } from './MessageRetryService';
export { getBackgroundBleService } from './BackgroundBleService';
export { getBackgroundBleService as getBackgroundBLEService } from './BackgroundBleService';
/** @deprecated Utiliser le système d'ACK natif du firmware via BleProvider */
export { getAckService, initAckService } from './AckService';
export { runMigration, isMigrationNeeded, resetMigration } from './MigrationService';
export { getChunkManager, initChunkManager, ChunkSender } from './ChunkManager';
export {
  syncPendingMessages,
  registerBackgroundTasks,
  unregisterBackgroundTasks,
  getBackgroundTasksStatus,
  TASK_MESSAGE_SYNC,
  TASK_CASHU_VERIFY,
} from './BackgroundTaskService';
