/**
 * ChunkManager - Gère l'envoi et la réception de messages chunkés
 * Pour messages longs qui dépassent la limite LoRa (200 bytes)
 */
import {
  MeshCorePacket,
  chunkMessage,
  createChunkPacket,
  reassembleChunks,
  isChunkPacket,
  extractChunkInfo,
  validateMessageSize,
  LORA_MAX_TEXT_CHARS,
} from '@/utils/meshcore-protocol';

interface PendingChunks {
  messageId: number;
  totalChunks: number;
  chunks: Map<number, Uint8Array>;
  receivedAt: number;
}

// ✅ FIX: Constante pour la boucle anti-collision de messageId
const MAX_MESSAGE_ID = 65535;
const MESSAGE_ID_COLLISION_RETRIES = 5;

class ChunkManager {
  private pendingReassembly = new Map<number, PendingChunks>();
  private completedAssemblies = new Map<number, string>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly CHUNK_TIMEOUT = 30 * 1000; // 30 secondes (était 5 min - trop long)
  private lastMessageId = 0;

  // Set pour détecter les chunks dupliqués (hash du contenu)
  private receivedChunkHashes = new Set<string>();

  constructor() {
    // Nettoyage périodique des chunks expirés
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /**
   * ✅ FIX: Génère un messageId avec garde anti-collision
   */
  private getNextMessageId(): number {
    for (let attempt = 0; attempt < MESSAGE_ID_COLLISION_RETRIES; attempt++) {
      this.lastMessageId = (this.lastMessageId + 1) % MAX_MESSAGE_ID;
      // Vérifier que cet ID n'est pas déjà utilisé pour un assemblage en cours
      if (!this.pendingReassembly.has(this.lastMessageId)) {
        return this.lastMessageId;
      }
    }
    // Si toutes les tentatives échouent, utiliser un ID basé sur le timestamp
    const fallbackId = Date.now() % MAX_MESSAGE_ID;
    console.warn(`[ChunkManager] Collision d'ID persistante, fallback vers timestamp: ${fallbackId}`);
    return fallbackId;
  }

  /**
   * Vérifie si un message nécessite du chunking
   */
  needsChunking(text: string): boolean {
    const validation = validateMessageSize(text);
    return !validation.valid;
  }

  /**
   * Envoie un message avec chunking automatique si nécessaire
   * Retourne le nombre de chunks envoyés (0 si erreur)
   */
  async sendMessageWithChunking(
    text: string,
    fromNodeId: string,
    toNodeId: string,
    sendFunction: (packet: MeshCorePacket) => Promise<void>,
    encrypted: boolean = false
  ): Promise<{ success: boolean; chunksSent: number; error?: string }> {
    // Vérifier si chunking nécessaire
    if (!this.needsChunking(text)) {
      // Message court: envoi normal
      try {
        const { createTextMessageSync } = await import('@/utils/meshcore-protocol');
        const packet = createTextMessageSync(fromNodeId, toNodeId, text, encrypted);
        await sendFunction(packet);
        return { success: true, chunksSent: 1 };
      } catch (error) {
        return { success: false, chunksSent: 0, error: String(error) };
      }
    }

    // Message long: chunking
    const messageId = this.getNextMessageId();
    const chunks = chunkMessage(text, messageId);
    
    if (!chunks || chunks.length === 0) {
      return { success: false, chunksSent: 0, error: 'Erreur chunking' };
    }

    console.log(`[ChunkManager] Envoi de ${chunks.length} chunks pour message ${messageId}`);

    // Envoyer chaque chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const packet = createChunkPacket(fromNodeId, toNodeId, chunk, encrypted);
      
      try {
        await sendFunction(packet);
        console.log(`[ChunkManager] Chunk ${i + 1}/${chunks.length} envoyé`);
      } catch (error) {
        console.error(`[ChunkManager] Erreur envoi chunk ${i}:`, error);
        return { 
          success: false, 
          chunksSent: i, 
          error: `Échec chunk ${i}: ${error}` 
        };
      }
      
      // Petit délai entre chunks pour ne pas saturer LoRa
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return { success: true, chunksSent: chunks.length };
  }

  /**
   * Traite un chunk reçu
   * Retourne le message complet si tous les chunks sont reçus
   */
  handleIncomingChunk(packet: MeshCorePacket): { complete: boolean; message?: string; progress?: number; error?: string } {
    if (!isChunkPacket(packet)) {
      return { complete: false };
    }

    const info = extractChunkInfo(packet.payload);
    if (!info) {
      console.error('[ChunkManager] Chunk invalide');
      return { complete: false };
    }

    const { messageId, chunkIndex, totalChunks, data } = info;

    // Récupérer ou créer le pending
    let pending = this.pendingReassembly.get(messageId);
    if (!pending) {
      pending = {
        messageId,
        totalChunks,
        chunks: new Map(),
        receivedAt: Date.now(),
      };
      this.pendingReassembly.set(messageId, pending);
    }

    // Vérifier si ce chunk est un doublon (hash du contenu)
    const chunkHash = this.computeChunkHash(packet.payload, messageId, chunkIndex);
    if (pending.chunks.has(chunkIndex)) {
      console.warn(`[ChunkManager] Chunk ${chunkIndex} déjà reçu pour message ${messageId} - ignoré`);
      return { complete: false, progress: Math.round((pending.chunks.size / totalChunks) * 100) };
    }
    
    // Ajouter le chunk
    pending.chunks.set(chunkIndex, packet.payload);
    
    const progress = Math.round((pending.chunks.size / totalChunks) * 100);
    console.log(`[ChunkManager] Chunk ${chunkIndex + 1}/${totalChunks} reçu (${progress}%)`);

    // Vérifier si complet
    if (pending.chunks.size === totalChunks) {
      const message = reassembleChunks(pending.chunks, totalChunks);
      this.pendingReassembly.delete(messageId);
      
      if (message) {
        console.log(`[ChunkManager] Message ${messageId} reconstitué (${message.length} caractères)`);
        return { complete: true, message, progress: 100 };
      } else {
        return { complete: false, progress, error: 'Reconstitution échouée' };
      }
    }

    return { complete: false, progress };
  }

  /**
   * ✅ FIX: Retourne les statistiques du ChunkManager
   */
  getStats(): {
    pendingReassembly: number;
    completedAssemblies: number;
    receivedChunkHashes: number;
  } {
    return {
      pendingReassembly: this.pendingReassembly.size,
      completedAssemblies: this.completedAssemblies.size,
      receivedChunkHashes: this.receivedChunkHashes.size,
    };
  }

  /**
   * ✅ FIX: Nettoie les assemblages complétés
   */
  clearCompletedAssemblies(): void {
    const count = this.completedAssemblies.size;
    this.completedAssemblies.clear();
    if (count > 0) {
      console.log(`[ChunkManager] ${count} assemblages complétés nettoyés`);
    }
  }

  /**
   * Nettoie les chunks expirés
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [messageId, pending] of this.pendingReassembly) {
      if (now - pending.receivedAt > this.CHUNK_TIMEOUT) {
        this.pendingReassembly.delete(messageId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[ChunkManager] ${cleaned} messages chunkés expirés nettoyés`);
    }
  }

  /**
   * Retourne le nombre de messages en cours de reconstitution
   */
  getPendingCount(): number {
    return this.pendingReassembly.size;
  }

  /**
   * Calcule un hash simple pour détecter les chunks dupliqués
   */
  private computeChunkHash(data: Uint8Array, messageId: number, chunkIndex: number): string {
    // Hash simple: somme des bytes + métadonnées
    let sum = 0;
    for (let i = 0; i < Math.min(data.length, 100); i++) {
      sum = (sum + data[i]) % 65536;
    }
    return `${messageId}:${chunkIndex}:${sum}:${data.length}`;
  }

  /**
   * Détruit le manager
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.pendingReassembly.clear();
    this.completedAssemblies.clear();
    this.receivedChunkHashes.clear();
  }
}

// Singleton
let chunkManager: ChunkManager | null = null;

export function getChunkManager(): ChunkManager {
  if (!chunkManager) {
    chunkManager = new ChunkManager();
  }
  return chunkManager;
}

export function initChunkManager(): ChunkManager {
  chunkManager = new ChunkManager();
  return chunkManager;
}

/**
 * ✅ FIX: ChunkSender — gestionnaire d'envoi de chunks avec mécanisme de cancel
 * et vérification de connexion BLE entre chaque chunk.
 */
export class ChunkSender {
  private chunks: MeshCorePacket[] = [];
  private currentIndex = 0;
  private isCancelled = false;
  private sendFunction: (packet: MeshCorePacket) => Promise<void>;
  private checkConnection: () => boolean;
  private readonly MAX_SEND_ATTEMPTS = 1000; // ✅ FIX: Garde contre boucle infinie

  constructor(
    chunks: MeshCorePacket[],
    sendFunction: (packet: MeshCorePacket) => Promise<void>,
    checkConnection: () => boolean
  ) {
    this.chunks = chunks;
    this.sendFunction = sendFunction;
    this.checkConnection = checkConnection;
  }

  /**
   * Annule l'envoi en cours
   */
  cancel(): void {
    this.isCancelled = true;
    console.log('[ChunkSender] Envoi annulé');
  }

  /**
   * Envoie tous les chunks un par un
   */
  async sendAll(): Promise<{ success: boolean; sent: number; error?: string }> {
    this.currentIndex = 0;
    this.isCancelled = false;
    let attempts = 0;

    while (this.currentIndex < this.chunks.length) {
      // ✅ FIX: Garde contre boucle infinie
      attempts++;
      if (attempts > this.MAX_SEND_ATTEMPTS) {
        return { success: false, sent: this.currentIndex, error: 'Nombre max de tentatives atteint' };
      }

      // ✅ FIX: Vérifier si l'envoi a été annulé
      if (this.isCancelled) {
        return { success: false, sent: this.currentIndex, error: 'Envoi annulé' };
      }

      // ✅ FIX: Vérifier la connexion BLE entre chaque chunk
      if (!this.checkConnection()) {
        return { success: false, sent: this.currentIndex, error: 'Connexion BLE perdue' };
      }

      try {
        await this.sendFunction(this.chunks[this.currentIndex]);
        console.log(`[ChunkSender] Chunk ${this.currentIndex + 1}/${this.chunks.length} envoyé`);
        this.currentIndex++;

        // Petit délai entre chunks pour ne pas saturer LoRa
        if (this.currentIndex < this.chunks.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`[ChunkSender] Erreur envoi chunk ${this.currentIndex}:`, error);
        return {
          success: false,
          sent: this.currentIndex,
          error: `Échec chunk ${this.currentIndex}: ${error}`,
        };
      }
    }

    return { success: true, sent: this.currentIndex };
  }

  /**
   * Envoie le prochain chunk (mode manuel)
   */
  async sendNextChunk(): Promise<{ success: boolean; done: boolean; error?: string }> {
    // ✅ FIX: Garde contre boucle infinie / appels excessifs
    if (this.currentIndex >= this.chunks.length) {
      return { success: true, done: true };
    }

    if (this.isCancelled) {
      return { success: false, done: true, error: 'Envoi annulé' };
    }

    // ✅ FIX: Vérifier la connexion BLE
    if (!this.checkConnection()) {
      return { success: false, done: false, error: 'Connexion BLE perdue' };
    }

    try {
      await this.sendFunction(this.chunks[this.currentIndex]);
      this.currentIndex++;

      const done = this.currentIndex >= this.chunks.length;
      if (!done) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      return { success: true, done };
    } catch (error) {
      return {
        success: false,
        done: false,
        error: `Échec chunk ${this.currentIndex}: ${error}`,
      };
    }
  }

  getProgress(): number {
    if (this.chunks.length === 0) return 0;
    return Math.round((this.currentIndex / this.chunks.length) * 100);
  }
}

export { LORA_MAX_TEXT_CHARS, validateMessageSize };
