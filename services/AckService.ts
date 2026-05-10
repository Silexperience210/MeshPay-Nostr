/**
 * Ack Service - Gestion des accusés de réception
 *
 * @deprecated Le firmware MeshCore Companion fournit un ACK natif
 * (RESP_CODE_SENT + PUSH_CODE_SEND_CONFIRMED). MeshPay l'utilise désormais
 * directement via BleProvider :
 *   - sendDirectMessage(pubkey, text, msgId) propage le DBMessage.id
 *   - utils/ble-gateway parse expected_ack et map vers msgId
 *   - BleProvider.onMessageAccepted → status « sent » en SQLite
 *   - BleProvider.onSendConfirmed → status « delivered » + clear retry queue
 *   - MessagesProvider listener → MAJ React state messagesByConv
 *
 * Ce service est conservé uniquement pour l'API externe `getAckService`
 * référencée par useAppInitialization et integration-check.
 *
 * NE PAS utiliser pour de nouveaux développements — implémentait un ACK
 * échoé over-the-air incompatible avec le format firmware natif.
 */
import { MeshCorePacket, createTextMessageSync } from '@/utils/meshcore-protocol';
import { updateMessageStatusDB } from '@/utils/database';

interface PendingAck {
  msgId: string;
  conversationId: string;
  timestamp: number;
  timeout: ReturnType<typeof setTimeout>;
  acknowledged: boolean;
  onAck?: () => void;
}

class AckService {
  private pendingAcks = new Map<string, PendingAck>();
  private onAckReceived?: (msgId: string) => void;
  private onAckTimeout?: (msgId: string) => void;

  constructor(
    onAckReceived?: (msgId: string) => void,
    onAckTimeout?: (msgId: string) => void
  ) {
    this.onAckReceived = onAckReceived;
    this.onAckTimeout = onAckTimeout;
  }

  /**
   * @deprecated Le firmware MeshCore Companion fournit un ACK natif.
   * Enregistre un ACK en attente et retourne une fonction pour résoudre l'ACK.
   */
  registerAck(
    msgId: string,
    conversationId: string,
    timeoutMs: number = 30000,
    onAck?: () => void
  ): () => void {
    // Nettoyer un ACK précédent pour ce msgId si existant
    this.cancelAck(msgId);

    const timeout = setTimeout(() => {
      const pending = this.pendingAcks.get(msgId);
      if (pending && !pending.acknowledged) {
        this.pendingAcks.delete(msgId);
        this.onAckTimeout?.(msgId);
        updateMessageStatusDB(msgId, 'failed').catch(err => {
          console.error('[AckService] Erreur mise à jour statut timeout:', err);
        });
      }
    }, timeoutMs);

    const pending: PendingAck = {
      msgId,
      conversationId,
      timestamp: Date.now(),
      timeout,
      acknowledged: false,
      onAck,
    };
    this.pendingAcks.set(msgId, pending);

    // Retourne une fonction pour résoudre manuellement l'ACK
    return () => {
      this.handleAck(msgId);
    };
  }

  /**
   * Traite un ACK reçu — met acknowledged à true et invoque onAck
   */
  handleAck(msgId: string): void {
    const pending = this.pendingAcks.get(msgId);
    if (!pending) {
      console.warn(`[AckService] handleAck: ACK reçu pour msgId inconnu: ${msgId}`);
      return;
    }

    if (pending.acknowledged) {
      console.warn(`[AckService] handleAck: ACK déjà traité pour msgId: ${msgId}`);
      return;
    }

    // ✅ FIX: Marquer comme acknowledged et invoquer le callback
    pending.acknowledged = true;
    clearTimeout(pending.timeout);

    console.log(`[AckService] ACK reçu pour msgId: ${msgId}`);

    // Invoquer le callback spécifique à cet ACK
    pending.onAck?.();

    // Invoquer le callback global
    this.onAckReceived?.(msgId);

    // Nettoyer
    this.pendingAcks.delete(msgId);
  }

  /**
   * @deprecated Le firmware gère les ACK natifs.
   * Cette méthode est un no-op pour éviter toute interaction avec le BLE.
   */
  async sendWithAck(
    packet: MeshCorePacket,
    originalMsgId: string,
    conversationId: string,
    timeoutMs: number = 30000
  ): Promise<boolean> {
    console.warn('[AckService] sendWithAck est deprecated — utiliser BleProvider directement');
    return false;
  }

  /**
   * @deprecated Utiliser handleAck(msgId) directement.
   */
  async handleIncomingAck(packet: MeshCorePacket): Promise<void> {
    console.warn('[AckService] handleIncomingAck est deprecated — utiliser handleAck(msgId)');
  }

  /**
   * @deprecated
   */
  createAckPacket(originalMsgId: string, toNodeId: string): MeshCorePacket {
    console.warn('[AckService] createAckPacket est deprecated');
    const myNodeId = 'MESH-0000';
    return createTextMessageSync(myNodeId, toNodeId, originalMsgId);
  }

  /**
   * Annule l'attente d'ACK
   */
  cancelAck(msgId: string): void {
    const pending = this.pendingAcks.get(msgId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingAcks.delete(msgId);
    }
  }

  /**
   * Retourne le nombre d'ACKs en attente
   */
  getPendingCount(): number {
    return this.pendingAcks.size;
  }

  /**
   * Nettoie les ACKs expirés
   */
  cleanup(): void {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    for (const [msgId, pending] of this.pendingAcks) {
      if (now - pending.timestamp > maxAge && !pending.acknowledged) {
        clearTimeout(pending.timeout);
        this.pendingAcks.delete(msgId);
        // ✅ FIX: Gérer l'erreur de updateMessageStatusDB (Promise non await)
        updateMessageStatusDB(msgId, 'failed').catch(err => {
          console.error('[AckService] Erreur mise à jour statut cleanup:', err);
        });
      }
    }
  }
}

// Singleton
let ackService: AckService | null = null;

export function getAckService(
  onAckReceived?: (msgId: string) => void,
  onAckTimeout?: (msgId: string) => void
): AckService {
  if (!ackService) {
    ackService = new AckService(onAckReceived, onAckTimeout);
  }
  return ackService;
}

export function initAckService(
  onAckReceived?: (msgId: string) => void,
  onAckTimeout?: (msgId: string) => void
): AckService {
  ackService = new AckService(onAckReceived, onAckTimeout);
  return ackService;
}
