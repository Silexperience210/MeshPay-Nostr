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
 * référencée par useAppInitialization et integration-check, mais ses méthodes
 * sont des no-op. À supprimer une fois ces deux call-sites nettoyés.
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
   * @deprecated Le firmware gère les ACK natifs.
   */
  async handleIncomingAck(packet: MeshCorePacket): Promise<void> {
    // no-op — les ACK sont gérés par BleGatewayClient + BleProvider
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
      if (now - pending.timestamp > maxAge) {
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
