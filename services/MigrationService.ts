/**
 * Migration Service - Point d'entrée unifié pour les migrations
 * 
 * ✅ CORRECTION: Ce service délègue maintenant toute la logique de migration
 * à database.ts/migrateFromAsyncStorage() pour éviter le double système.
 * 
 * Ce fichier est conservé pour compatibilité avec le code existant qui importe
 * depuis ce service, mais toute la logique métier est dans database.ts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { 
  migrateFromAsyncStorage,
  saveConversationDB,
  saveMessageDB,
  DBConversation,
  DBMessage,
  getDatabase,
  withTransaction,
  toSQLiteParams,
} from '@/utils/database';

const MIGRATION_KEY = 'migration_v1_completed';

interface OldConversation {
  id: string;
  name: string;
  isForum: boolean;
  peerPubkey?: string;
  lastMessage: string;
  lastMessageTime: number;
  unreadCount: number;
  online: boolean;
}

interface OldMessage {
  id: string;
  conversationId: string;
  from: string;
  fromPubkey: string;
  text: string;
  type: 'text' | 'cashu' | 'btc_tx' | 'lora';
  timestamp: number;
  isMine: boolean;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  cashuAmount?: number;
  cashuToken?: string;
  btcAmount?: number;
}

/**
 * Vérifie si la migration est nécessaire
 */
export async function isMigrationNeeded(): Promise<boolean> {
  const completed = await AsyncStorage.getItem(MIGRATION_KEY);
  return completed !== 'true';
}

/**
 * ✅ CORRECTION: Exécute la migration en déléguant à database.ts
 * 
 * La logique de migration est maintenant centralisée dans database.ts pour:
 * 1. Éviter la duplication de code
 * 2. Utiliser les batch inserts optimisés
 * 3. Garantir l'atomicité avec les transactions
 */
export async function runMigration(): Promise<{ success: boolean; migrated: number }> {
  console.log('[Migration] Délégation à migrateFromAsyncStorage()...');
  
  try {
    // ✅ CORRECTION: Utiliser la fonction unifiée de database.ts
    await migrateFromAsyncStorage();
    
    // Compter les éléments migrés pour la compatibilité avec l'ancienne API
    const database = await getDatabase();
    const convCount = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM conversations');
    const msgCount = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) as count FROM messages');
    
    const totalMigrated = (convCount?.count || 0) + (msgCount?.count || 0);
    
    return { success: true, migrated: totalMigrated };
  } catch (error) {
    console.error('[Migration] Erreur:', error);
    return { success: false, migrated: 0 };
  }
}

/**
 * ✅ CORRECTION: Migration avec batch insert pour N+1 queries
 * Cette fonction est conservée pour compatibilité mais utilise avecTransaction
 */
export async function runMigrationBatched(): Promise<{ success: boolean; migrated: number }> {
  console.log('[Migration] Démarrage migration batch optimisée...');

  try {
    const database = await getDatabase();
    
    // Vérifier si déjà migré
    const completed = await AsyncStorage.getItem(MIGRATION_KEY);
    if (completed === 'true') {
      console.log('[Migration] Déjà effectuée');
      return { success: true, migrated: 0 };
    }
    
    let totalMigrated = 0;
    
    await withTransaction(async (db) => {
      // Migrer les conversations en batch
      const convsRaw = await AsyncStorage.getItem('meshcore_conversations');
      if (convsRaw) {
        const conversations: OldConversation[] = JSON.parse(convsRaw);
        
        if (conversations.length > 0) {
          const placeholders = conversations.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
          const params: any[] = [];
          
          for (const conv of conversations) {
            params.push(
              conv.id,
              conv.name,
              conv.isForum ? 1 : 0,
              conv.peerPubkey || null,
              conv.lastMessage,
              conv.lastMessageTime,
              conv.unreadCount,
              conv.online ? 1 : 0
            );
          }
          
          await db.runAsync(
            `INSERT OR IGNORE INTO conversations 
             (id, name, isForum, peerPubkey, lastMessage, lastMessageTime, unreadCount, online)
             VALUES ${placeholders}`,
            toSQLiteParams(params)
          );
          
          totalMigrated += conversations.length;
          console.log(`[Migration] ${conversations.length} conversations migrées`);
        }
      }

      // Migrer les messages en batch par conversation
      const MSG_PREFIX = 'meshcore_msgs_';
      const keys = await AsyncStorage.getAllKeys();
      const msgKeys = keys.filter(k => k.startsWith(MSG_PREFIX));

      for (const key of msgKeys) {
        const msgsRaw = await AsyncStorage.getItem(key);
        if (!msgsRaw) continue;

        const messages: OldMessage[] = JSON.parse(msgsRaw);
        if (messages.length === 0) continue;
        
        const BATCH_SIZE = 100;
        for (let i = 0; i < messages.length; i += BATCH_SIZE) {
          const batch = messages.slice(i, i + BATCH_SIZE);
          const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
          const params: any[] = [];
          
          for (const msg of batch) {
            params.push(
              msg.id,
              msg.conversationId,
              msg.from,
              msg.fromPubkey,
              msg.text,
              msg.type,
              msg.timestamp,
              msg.isMine ? 1 : 0,
              msg.status,
              msg.cashuAmount || null,
              msg.cashuToken || null
            );
          }
          
          await db.runAsync(
            `INSERT OR IGNORE INTO messages 
             (id, conversationId, fromNodeId, fromPubkey, text, type, timestamp, isMine, status, cashuAmount, cashuToken)
             VALUES ${placeholders}`,
            toSQLiteParams(params)
          );
          
          totalMigrated += batch.length;
        }
      }

      console.log(`[Migration] Messages migrés`);
    });

    // Marquer comme complété
    await AsyncStorage.setItem(MIGRATION_KEY, 'true');
    console.log(`[Migration] Terminée. Total: ${totalMigrated}`);

    return { success: true, migrated: totalMigrated };
  } catch (error) {
    console.error('[Migration] Erreur:', error);
    return { success: false, migrated: 0 };
  }
}

/**
 * Réinitialise la migration (pour tests)
 */
export async function resetMigration(): Promise<void> {
  await AsyncStorage.removeItem(MIGRATION_KEY);
  await AsyncStorage.removeItem('meshcore_migration_done');
  console.log('[Migration] Réinitialisée');
}
