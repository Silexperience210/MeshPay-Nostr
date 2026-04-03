/**
 * Message Retry Service - File d'attente persistante pour messages hors ligne
 * Remplace la queue en mémoire (useRef) par SQLite
 *
 * ✅ FIX : cancelAllForConversation maintenant fonctionnel
 *    → Nécessite d'avoir appliqué database.patch.ts dans utils/database.ts
 */
import { MeshCorePacket, encodeMeshCorePacket } from '@/utils/meshcore-protocol';
import {
  queuePendingMessage,
  getPendingMessages,
  removePendingMessage,
  removePendingMessagesByConversation,  // ← NOUVEAU import
  incrementRetryCount,
  PendingMessage,
} from '@/utils/database';
import { getBleGatewayClient } from '@/utils/ble-gateway';

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_INTERVAL_BASE = 5000;  // 5 secondes
const RETRY_INTERVAL_MAX = 60000;  // 1 minute

class MessageRetryService {
  private isProcessing = false;
  private processingInterval: ReturnType<typeof setInterval> | null = null;
  private onStatusChange?: (msgId: string, status: 'sending' | 'sent' | 'failed') => void;

  constructor(onStatusChange?: (msgId: string, status: 'sending' | 'sent' | 'failed') => void) {
    this.onStatusChange = onStatusChange;
  }

  /**
   * Démarre le service de retry automatique
   */
  start(): void {
    if (this.processingInterval) return;

    console.log('[MessageRetryService] Démarré');

    // Vérifier toutes les 10 secondes
    this.processingInterval = setInterval(() => {
      this.processQueue();
    }, 10000);

    // Premier traitement immédiat
    this.processQueue();
  }

  /**
   * Arrête le service
   */
  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    console.log('[MessageRetryService] Arrêté');
  }

  /**
   * Ajoute un message à la file d'attente
   *
   * @param msgId       Identifiant unique du message
   * @param packet      Paquet MeshCore à envoyer
   * @param maxRetries  Nombre max de tentatives (défaut: 3)
   * @param conversationId  ← NOUVEAU : identifiant de la conversation
   */
  async queueMessage(
    msgId: string,
    packet: MeshCorePacket,
    maxRetries: number = MAX_RETRY_ATTEMPTS,
    conversationId?: string    // ← NOUVEAU paramètre
  ): Promise<void> {
    const encoded = encodeMeshCorePacket(packet);
    await queuePendingMessage(msgId, encoded, maxRetries, conversationId);
    console.log('[MessageRetryService] Message mis en file d\'attente:', msgId,
      conversationId ? `(conv: ${conversationId})` : '');

    // Essayer d'envoyer immédiatement
    this.processQueue();
  }

  /**
   * Traite la file d'attente
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const pending = await getPendingMessages();

      if (pending.length === 0) {
        this.isProcessing = false;
        return;
      }

      console.log(`[MessageRetryService] ${pending.length} messages en attente`);

      const bleClient = getBleGatewayClient();
      const isConnected = bleClient.isConnected();

      if (!isConnected) {
        console.log('[MessageRetryService] BLE non connecté, report...');
        this.isProcessing = false;
        return;
      }

      for (const msg of pending) {
        try {
          this.onStatusChange?.(msg.id, 'sending');

          // Envoyer via BLE
          await bleClient.sendPacket(msg.packet as any);

          // Succès - supprimer de la file
          await removePendingMessage(msg.id);
          this.onStatusChange?.(msg.id, 'sent');

          console.log('[MessageRetryService] Message envoyé:', msg.id);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error('[MessageRetryService] Erreur envoi:', msg.id, errorMsg);

          // Incrémenter le compteur de retry
          await incrementRetryCount(msg.id, errorMsg);

          // Vérifier si max retries atteint
          if (msg.retries + 1 >= msg.maxRetries) {
            this.onStatusChange?.(msg.id, 'failed');
            console.log('[MessageRetryService] Max retries atteint:', msg.id);
          }
        }
      }
    } catch (error) {
      console.error('[MessageRetryService] Erreur traitement queue:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Calcule le délai avant le prochain retry (backoff exponentiel)
   */
  private calculateRetryDelay(retryCount: number): number {
    const delay = RETRY_INTERVAL_BASE * Math.pow(2, retryCount);
    return Math.min(delay, RETRY_INTERVAL_MAX);
  }

  /**
   * Retourne le nombre de messages en attente
   */
  async getPendingCount(): Promise<number> {
    const pending = await getPendingMessages();
    return pending.length;
  }

  /**
   * Annule un message en attente par son ID
   */
  async cancelMessage(msgId: string): Promise<void> {
    await removePendingMessage(msgId);
    this.onStatusChange?.(msgId, 'failed');
    console.log('[MessageRetryService] Message annulé:', msgId);
  }

  /**
   * ✅ FIX : Annule tous les messages d'une conversation
   *
   * AVANT : ne faisait rien (TODO)
   * APRÈS : supprime en base via conversation_id
   *
   * Prérequis : avoir appliqué database.patch.ts
   */
  async cancelAllForConversation(conversationId: string): Promise<void> {
    try {
      // Récupère les IDs avant suppression pour notifier le UI
      const pending = await getPendingMessages();
      const conversationMessages = pending.filter(
        msg => msg.conversationId === conversationId
      );

      // Suppression groupée en base (une seule requête SQL)
      const deletedCount = await removePendingMessagesByConversation(conversationId);

      // Notifie le UI pour chaque message supprimé
      for (const msg of conversationMessages) {
        this.onStatusChange?.(msg.id, 'failed');
      }

      console.log(
        `[MessageRetryService] ${deletedCount} messages annulés pour la conversation: ${conversationId}`
      );
    } catch (error) {
      console.error('[MessageRetryService] Erreur cancelAllForConversation:', error);
      throw error;
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────
let retryService: MessageRetryService | null = null;

export function getMessageRetryService(
  onStatusChange?: (msgId: string, status: 'sending' | 'sent' | 'failed') => void
): MessageRetryService {
  if (!retryService) {
    retryService = new MessageRetryService(onStatusChange);
  }
  return retryService;
}

export function initMessageRetryService(
  onStatusChange?: (msgId: string, status: 'sending' | 'sent' | 'failed') => void
): MessageRetryService {
  retryService = new MessageRetryService(onStatusChange);
  return retryService;
}
