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
import { MeshCorePacket, MeshCoreMessageType, createTextMessageSync, nodeIdToUint64, uint64ToNodeId } from '@/utils/meshcore-protocol';
import { getBleGatewayClient } from '@/utils/ble-gateway';
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
   * Envoie un message et attend l'ACK
   */
  async sendWithAck(
    packet: MeshCorePacket,
    originalMsgId: string,
    conversationId: string,
    timeoutMs: number = 30000
  ): Promise<boolean> {
    const client = getBleGatewayClient();
    
    return new Promise((resolve) => {
      // Envoyer le message
      client.sendPacket(packet).catch(() => {
        resolve(false);
      });

      // Mettre en attente d'ACK
      const timeout = setTimeout(async () => {
        this.pendingAcks.delete(originalMsgId);
        await updateMessageStatusDB(originalMsgId, 'failed');
        this.onAckTimeout?.(originalMsgId);
        resolve(false);
      }, timeoutMs);

      this.pendingAcks.set(originalMsgId, {
        msgId: originalMsgId,
        conversationId,
        timestamp: Date.now(),
        timeout,
      });

      // Mettre à jour le statut
      updateMessageStatusDB(originalMsgId, 'sending').catch(err => {
        console.error('[AckService] Erreur mise à jour statut:', err);
      });
    });
  }

  /**
   * Traite un ACK reçu
   */
  async handleIncomingAck(packet: MeshCorePacket): Promise<void> {
    const ackMsgId = packet.payload[0]?.toString(); // Simplifié
    
    if (!ackMsgId) return;

    const pending = this.pendingAcks.get(ackMsgId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingAcks.delete(ackMsgId);
      
      // ✅ CORRECTION: try/catch pour updateMessageStatusDB
      try {
        await updateMessageStatusDB(ackMsgId, 'delivered');
        this.onAckReceived?.(ackMsgId);
        console.log('[AckService] ACK reçu pour:', ackMsgId);
      } catch (err) {
        console.error('[AckService] Erreur mise à jour statut ACK:', err);
      }
    }
  }

  /**
   * Crée un paquet ACK
   */
  createAckPacket(originalMsgId: string, toNodeId: string): MeshCorePacket {
    // Utiliser l'identité du wallet si disponible, sinon fallback
    const myNodeId = 'MESH-0000';
    
    const encoder = new TextEncoder();
    const payload = encoder.encode(originalMsgId);
    
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
