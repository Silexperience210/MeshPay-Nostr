/**
 * Hook React pour gérer l'identité unifiée - Optimisé (logs supprimés)
 * 
 * Fournit une interface React-friendly pour le UnifiedIdentityManager
 * avec gestion d'état pour le verrouillage et les opérations asynchrones.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { InteractionManager } from 'react-native';
import {
  UnifiedIdentityManager,
  getIdentityManager,
  UnifiedIdentity,
  CreateIdentityResult,
  EncryptedBackup,
  IdentityError,
} from '../identity';
import { generateMnemonic } from '@/utils/bitcoin';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UseUnifiedIdentityState {
  /** L'identité est-elle initialisée (présente dans le stockage)? */
  hasIdentity: boolean;
  /** L'identité est-elle déverrouillée? */
  isUnlocked: boolean;
  /** Une opération est-elle en cours? */
  isLoading: boolean;
  /** Message d'erreur éventuel */
  error: string | null;
  /** L'identité complète (uniquement si déverrouillée) */
  identity: UnifiedIdentity | null;
  /** Identité publique (toujours disponible) */
  publicIdentity: {
    bitcoin: { xpub: string; fingerprint: string; firstAddress: string };
    nostr: { pubkey: string; npub: string };
    meshcore: { pubkey: string; nodeId: string };
  } | null;
}

export interface UseUnifiedIdentityActions {
  /**
   * Crée une nouvelle identité avec un mnemonic généré.
   * @param strength - Nombre de mots (12 ou 24)
   * @param password - Mot de passe de chiffrement
   * @returns Le mnemonic généré (à sauvegarder!)
   */
  createWallet: (strength: 12 | 24, password: string) => Promise<string>;

  /**
   * Restaure une identité depuis un mnemonic existant.
   * @param mnemonic - Phrase mnémonique BIP39
   * @param password - Mot de passe de chiffrement
   */
  restoreWallet: (mnemonic: string, password: string) => Promise<void>;

  /**
   * Déverrouille l'identité avec le mot de passe.
   * @param password - Mot de passe
   * @returns true si succès
   */
  unlock: (password: string) => Promise<boolean>;

  /**
   * Verrouille l'identité (efface les clés de la mémoire).
   */
  lock: () => void;

  /**
   * Exporte un backup chiffré.
   * @param password - Mot de passe actuel
   * @returns Le backup chiffré en JSON
   */
  exportBackup: (password: string) => Promise<string>;

  /**
   * Importe une identité depuis un backup.
   * @param backupJson - JSON du backup
   * @param password - Mot de passe de déchiffrement
   */
  importBackup: (backupJson: string, password: string) => Promise<void>;

  /**
   * Migre depuis l'ancien système (wallet + nostr séparés).
   * @param walletMnemonic - Mnemonic du wallet existant
   * @param nostrPrivkey - Clé privée Nostr existante
   * @param password - Nouveau mot de passe
   */
  migrateFromLegacy: (
    walletMnemonic: string,
    nostrPrivkey: string,
    password: string
  ) => Promise<void>;

  /**
   * Supprime l'identité (irréversible).
   */
  deleteIdentity: () => Promise<void>;

  /**
   * Efface l'erreur courante.
   */
  clearError: () => void;
}

export type UseUnifiedIdentityReturn = UseUnifiedIdentityState & UseUnifiedIdentityActions;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useUnifiedIdentity(): UseUnifiedIdentityReturn {
  // ─── État ───────────────────────────────────────────────────────────────────
  const managerRef = useRef<UnifiedIdentityManager | null>(null);
  
  const [state, setState] = useState<Omit<UseUnifiedIdentityState, 'isLoading' | 'error'>>({
    hasIdentity: false,
    isUnlocked: false,
    identity: null,
    publicIdentity: null,
  });
  
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Initialisation ─────────────────────────────────────────────────────────
  useEffect(() => {
    managerRef.current = getIdentityManager();
    
    // Vérifier si une identité existe
    checkIdentity();

    return () => {
      // Cleanup: verrouiller à la destruction du composant
      if (managerRef.current?.getIsUnlocked()) {
        managerRef.current.lock();
      }
    };
  }, []);

  // ─── Helpers ────────────────────────────────────────────────────────────────
  const getManager = useCallback((): UnifiedIdentityManager => {
    if (!managerRef.current) {
      throw new Error('UnifiedIdentityManager not initialized');
    }
    return managerRef.current;
  }, []);

  const checkIdentity = useCallback(async () => {
    const manager = getManager();
    const hasIdentity = await manager.hasIdentity();
    
    if (hasIdentity) {
      const publicIdentity = await manager.getPublicIdentity();
      setState(prev => ({
        ...prev,
        hasIdentity: true,
        publicIdentity: publicIdentity ? {
          bitcoin: publicIdentity.bitcoin,
          nostr: publicIdentity.nostr,
          meshcore: publicIdentity.meshcore,
        } : null,
      }));
    } else {
      setState(prev => ({
        ...prev,
        hasIdentity: false,
        isUnlocked: false,
        identity: null,
        publicIdentity: null,
      }));
    }
  }, [getManager]);

  const handleError = useCallback((err: unknown): string => {
    let message = 'Une erreur est survenue';
    
    if (err instanceof IdentityError) {
      message = err.message;
    } else if (err instanceof Error) {
      message = err.message;
    } else if (typeof err === 'string') {
      message = err;
    }
    
    setError(message);
    return message;
  }, []);

  // ─── Actions ────────────────────────────────────────────────────────────────

  /**
   * Crée un nouveau wallet avec un mnemonic généré.
   */
  const createWallet = useCallback(async (
    strength: 12 | 24 = 12,
    password: string
  ): Promise<string> => {
    setIsLoading(true);
    setError(null);

    try {
      // Defer heavy crypto until animations/transitions settle
      await new Promise<void>(resolve => InteractionManager.runAfterInteractions(() => resolve()));

      const manager = getManager();
      const mnemonic = generateMnemonic(strength);

      // Yield so the UI can show the loading spinner before heavy work
      await new Promise<void>(resolve => setTimeout(resolve, 50));

      const result = await manager.createIdentity(mnemonic, password);

      setState({
        hasIdentity: true,
        isUnlocked: true,
        identity: manager.getIdentity(),
        publicIdentity: {
          bitcoin: result.identity.bitcoin,
          nostr: result.identity.nostr,
          meshcore: result.identity.meshcore,
        },
      });

      return mnemonic;
    } catch (err) {
      handleError(err);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [getManager, handleError]);

  /**
   * Restaure un wallet depuis un mnemonic existant.
   */
  const restoreWallet = useCallback(async (
    mnemonic: string,
    password: string
  ): Promise<void> => {
    setIsLoading(true);
    setError(null);

    try {
      const manager = getManager();
      await manager.createIdentity(mnemonic, password);

      setState({
        hasIdentity: true,
        isUnlocked: true,
        identity: manager.getIdentity(),
        publicIdentity: null,
      });
    } catch (err) {
      handleError(err);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [getManager, handleError]);

  /**
   * Déverrouille l'identité.
   */
  const unlock = useCallback(async (password: string): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      const manager = getManager();
      const success = await manager.unlock(password);

      if (success) {
        setState(prev => ({
          ...prev,
          isUnlocked: true,
          identity: manager.getIdentity(),
        }));
      }

      return success;
    } catch (err) {
      handleError(err);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [getManager, handleError]);

  /**
   * Verrouille l'identité.
   */
  const lock = useCallback(() => {
    const manager = getManager();
    manager.lock();

    setState(prev => ({
      ...prev,
      isUnlocked: false,
      identity: null,
    }));
  }, [getManager]);

  /**
   * Exporte un backup chiffré.
   */
  const exportBackup = useCallback(async (password: string): Promise<string> => {
    setIsLoading(true);
    setError(null);

    try {
      const manager = getManager();
      const backup = await manager.exportBackup(password);
      return backup;
    } catch (err) {
      handleError(err);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [getManager, handleError]);

  /**
   * Importe une identité depuis un backup.
   */
  const importBackup = useCallback(async (
    backupJson: string,
    password: string
  ): Promise<void> => {
    setIsLoading(true);
    setError(null);

    try {
      const manager = getManager();
      await manager.importBackup(backupJson, password);

      setState({
        hasIdentity: true,
        isUnlocked: true,
        identity: manager.getIdentity(),
        publicIdentity: null,
      });
    } catch (err) {
      handleError(err);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [getManager, handleError]);

  /**
   * Migre depuis l'ancien système.
   */
  const migrateFromLegacy = useCallback(async (
    walletMnemonic: string,
    nostrPrivkey: string,
    password: string
  ): Promise<void> => {
    setIsLoading(true);
    setError(null);

    try {
      const manager = getManager();
      await manager.migrateFromLegacy(walletMnemonic, nostrPrivkey, password);

      setState({
        hasIdentity: true,
        isUnlocked: true,
        identity: manager.getIdentity(),
        publicIdentity: null,
      });
    } catch (err) {
      handleError(err);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [getManager, handleError]);

  /**
   * Supprime l'identité.
   */
  const deleteIdentity = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);

    try {
      const manager = getManager();
      await manager.deleteIdentity();

      setState({
        hasIdentity: false,
        isUnlocked: false,
        identity: null,
        publicIdentity: null,
      });
    } catch (err) {
      handleError(err);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [getManager, handleError]);

  /**
   * Efface l'erreur.
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // ─── Retour ─────────────────────────────────────────────────────────────────
  return {
    ...state,
    isLoading,
    error,
    createWallet,
    restoreWallet,
    unlock,
    lock,
    exportBackup,
    importBackup,
    migrateFromLegacy,
    deleteIdentity,
    clearError,
  };
}
