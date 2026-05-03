/**
 * useAppInitialization - Hook pour initialiser tous les services au démarrage
 * 
 * Ce hook garantit que:
 * 1. La migration AsyncStorage → SQLite est effectuée
 * 2. La base de données est initialisée
 * 3. Les services sont démarrés
 * 4. Les handlers sont enregistrés
 */
import { useEffect, useState } from 'react';
import { getDatabase, migrateFromAsyncStorage, updateMessageStatusDB } from '@/utils/database';
import { getMessageRetryService } from '@/services/MessageRetryService';
import { getAckService } from '@/services/AckService';
import { runIntegrationCheck } from '@/utils/integration-check';

interface InitState {
  isReady: boolean;
  isMigrating: boolean;
  error: string | null;
}

export function useAppInitialization(): InitState {
  const [state, setState] = useState<InitState>({
    isReady: false,
    isMigrating: false,
    error: null,
  });

  useEffect(() => {
    const initialize = async () => {
      try {
        // 1. Initialiser la base de données
        console.log('[Init] Initialisation de la base de données...');
        await getDatabase();

        // 1.5 Migrer les données depuis AsyncStorage si nécessaire (idempotent)
        console.log('[Init] Vérification migration AsyncStorage...');
        await migrateFromAsyncStorage();

        // 3. Initialiser les services
        console.log('[Init] Initialisation des services...');
        
        // Configurer le service de retry avec persistance SQLite
        const retryService = getMessageRetryService((msgId, status) => {
          console.log(`[Init] Message ${msgId}: ${status}`);
          // ✅ Persister le statut en SQLite pour qu'il survive au redémarrage
          if (status === 'sent' || status === 'failed') {
            updateMessageStatusDB(msgId, status).catch((err) =>
              console.warn('[Init] Retry status DB update failed:', err)
            );
          }
        });
        
        // Configurer le service ACK (deprecated — firmware natif gère les ACK)
        // Gardé pour compatibilité avec integration-check
        const ackService = getAckService(
          (msgId) => {
            console.log(`[Init] ACK legacy reçu pour ${msgId}`);
            updateMessageStatusDB(msgId, 'delivered').catch(() => {});
          },
          (msgId) => {
            console.log(`[Init] Timeout ACK legacy pour ${msgId}`);
            updateMessageStatusDB(msgId, 'failed').catch(() => {});
          }
        );

        // 4. Vérifier l'intégration complète
        console.log('[Init] Vérification de l\'intégration...');
        const integration = await runIntegrationCheck();
        if (!integration.database || !integration.retryService) {
          console.warn('[Init] Certains modules ont des problèmes:', integration.errors);
        }

        // 5. Marquer comme prêt
        setState({
          isReady: true,
          isMigrating: false,
          error: integration.errors.length > 0 ? integration.errors.join(', ') : null,
        });
        
        console.log('[Init] Application prête');
      } catch (error) {
        console.error('[Init] Erreur d\'initialisation:', error);
        setState({
          isReady: false,
          isMigrating: false,
          error: error instanceof Error ? error.message : 'Erreur inconnue',
        });
      }
    };

    initialize();
  }, []);

  return state;
}
