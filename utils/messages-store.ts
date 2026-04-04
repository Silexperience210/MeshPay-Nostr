/**
 * Messages Store - Facade pour la persistance des messages
 * 
 * Cette couche d'abstraction permet de changer facilement le backend de stockage.
 * Actuellement utilise SQLite (via database.ts).
 * 
 * Migration: AsyncStorage → SQLite (v2.0)
 */
import {
  listConversationsDB,
  saveConversationDB,
  loadMessagesDB,
  saveMessageDB,
  updateMessageStatusDB,
  updateConversationLastMessageDB,
  markConversationReadDB,
  DBConversation,
  DBMessage,
} from '@/utils/database';
// @ts-ignore - subpath exports use .js extension
import { randomBytes } from '@noble/hashes/utils.js';

// Re-export des types pour compatibilité
export type MessageType = 'text' | 'cashu' | 'btc_tx' | 'lora' | 'audio' | 'image' | 'gif';

export interface StoredMessage extends DBMessage {}

export interface StoredConversation extends DBConversation {}

// --- Conversations ---

export async function listConversations(): Promise<StoredConversation[]> {
  return listConversationsDB();
}

export async function saveConversation(conv: StoredConversation): Promise<void> {
  return saveConversationDB(conv);
}

export async function updateConversationLastMessage(
  convId: string,
  lastMessage: string,
  ts: number,
  incrementUnread: boolean
): Promise<void> {
  return updateConversationLastMessageDB(convId, lastMessage, ts, incrementUnread);
}

export async function updateConversationPubkey(
  convId: string,
  pubkey: string
): Promise<void> {
  // Récupérer la conversation existante
  const convs = await listConversationsDB();
  const conv = convs.find(c => c.id === convId);
  if (conv) {
    conv.peerPubkey = pubkey;
    await saveConversationDB(conv);
    console.log('[MessagesStore] Pubkey updated for:', convId);
  }
}

export async function markConversationRead(convId: string): Promise<void> {
  return markConversationReadDB(convId);
}

// --- Messages ---

export async function loadMessages(convId: string): Promise<StoredMessage[]> {
  return loadMessagesDB(convId, 200);
}

export async function saveMessage(msg: StoredMessage): Promise<void> {
  return saveMessageDB(msg);
}

export async function updateMessageStatus(
  msgId: string,
  status: StoredMessage['status']
): Promise<void> {
  return updateMessageStatusDB(msgId, status);
}

// --- Utils ---

/**
 * Génère une chaîne aléatoire sécurisée en base36
 * Utilise randomBytes de @noble/hashes pour la sécurité cryptographique
 * 
 * SÉCURITÉ (Fix VULN-007):
 * - Remplace Math.random() qui n'est pas cryptographiquement sûr
 * - Utilise un CSPRNG (Cryptographically Secure Pseudo-Random Number Generator)
 * 
 * @param length - Longueur souhaitée de la chaîne
 * @returns Chaîne aléatoire en base36
 */
function generateRandomBase36(length: number): string {
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    // Convertir chaque byte en caractère base36 (0-9, a-z)
    result += (bytes[i] % 36).toString(36);
  }
  return result;
}

/**
 * Génère un ID de message unique.
 * 
 * SÉCURITÉ (Fix VULN-007):
 * - N'utilise PLUS Math.random() qui est prévisible
 * - Utilise randomBytes() de @noble/hashes pour l'unpredictibilité cryptographique
 * 
 * @returns ID de message unique au format msg-{timestamp}-{random}
 */
export function generateMsgId(): string {
  const timestamp = Date.now().toString(36);
  const random = generateRandomBase36(5);
  return `msg-${timestamp}-${random}`;
}

/**
 * Génère un ID de message unique basé sur le compteur persistant
 * Préférer cette fonction à generateMsgId() pour les nouveaux messages
 */
export async function generateUniqueMsgId(): Promise<string> {
  const { getNextMessageId } = await import('@/utils/database');
  const counter = await getNextMessageId();
  const timestamp = Date.now().toString(36);
  const counterBase36 = counter.toString(36);
  return `msg-${timestamp}-${counterBase36}`;
}
