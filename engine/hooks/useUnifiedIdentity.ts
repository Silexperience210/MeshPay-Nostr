/**
 * Hook React pour gérer l'identité unifiée
 * 
 * Fournit une interface React-friendly pour le UnifiedIdentityManager
 * avec gestion d'état pour le verrouillage et les opérations asynchrones.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
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

  // ─── setState wrapper avec logging ──────────────────────────────────────────
  const setStateWithLog = useCallback((newState: typeof state | ((prev: typeof state) => typeof state)) => {
    console.log('[useUnifiedIdentity] === setState called ===');
    setState((prev) => {
      const resolved = typeof newState === 'function' ? (newState as Function)(prev) : newState;
      console.log('[useUnifiedIdentity] State change:', {
        prev: { hasIdentity: prev.hasIdentity, isUnlocked: prev.isUnlocked, hasIdentityObj: !!prev.identity, hasPublicIdentity: !!prev.publicIdentity },
        next: { hasIdentity: resolved.hasIdentity, isUnlocked: resolved.isUnlocked, hasIdentityObj: !!resolved.identity, hasPublicIdentity: !!resolved.publicIdentity },
      });
      return resolved;
    });
  }, []);

  // ─── Initialisation ─────────────────────────────────────────────────────────
  useEffect(() => {
    console.log('[useUnifiedIdentity] === HOOK MOUNTED ===');
    managerRef.current = getIdentityManager();
    console.log('[useUnifiedIdentity] Manager initialized');
    
    // Vérifier si une identité existe
    checkIdentity();

    return () => {
      console.log('[useUnifiedIdentity] === HOOK UNMOUNTED ===');
      // Cleanup: verrouiller à la destruction du composant
      if (managerRef.current?.getIsUnlocked()) {
        console.log('[useUnifiedIdentity] Locking identity on unmount');
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
    console.log('[useUnifiedIdentity] === checkIdentity START ===');
    const manager = getManager();
    const hasIdentity = await manager.hasIdentity();
    console.log('[useUnifiedIdentity] hasIdentity:', hasIdentity);
    
    if (hasIdentity) {
      const publicIdentity = await manager.getPublicIdentity();
      console.log('[useUnifiedIdentity] publicIdentity retrieved:', !!publicIdentity);
      setStateWithLog(prev => ({
        ...prev,
        hasIdentity: true,
        publicIdentity: publicIdentity ? {
          bitcoin: publicIdentity.bitcoin,
          nostr: publicIdentity.nostr,
          meshcore: publicIdentity.meshcore,
        } : null,
      }));
    } else {
      setStateWithLog(prev => ({
        ...prev,
        hasIdentity: false,
        isUnlocked: false,
        identity: null,
        publicIdentity: null,
      }));
    }
    console.log('[useUnifiedIdentity] === checkIdentity END ===');
  }, [getManager, setStateWithLog]);

  const handleError = useCallback((err: unknown): string => {
    console.log('[useUnifiedIdentity] === handleError ===');
    let message = 'Une erreur est survenue';
    
    if (err instanceof IdentityError) {
      message = err.message;
      console.log('[useUnifiedIdentity] IdentityError:', err.code, err.message);
    } else if (err instanceof Error) {
      message = err.message;
      console.log('[useUnifiedIdentity] Error:', err.message);
    } else if (typeof err === 'string') {
      message = err;
      console.log('[useUnifiedIdentity] String error:', err);
    } else {
      console.log('[useUnifiedIdentity] Unknown error:', err);
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
    console.log('[useUnifiedIdentity] === createWallet START ===');
    console.log('[useUnifiedIdentity] strength:', strength);
    console.log('[useUnifiedIdentity] password length:', password.length);
    
    setIsLoading(true);
    setError(null);
    console.log('[useUnifiedIdentity] isLoading set to true');

    try {
      const manager = getManager();
      console.log('[useUnifiedIdentity] Got manager instance');
      
      console.log('[useUnifiedIdentity] Calling generateMnemonic...');
      const mnemonic = generateMnemonic(strength);
      console.log('[useUnifiedIdentity] generateMnemonic done, length:', mnemonic.length);
      
      console.log('[useUnifiedIdentity] Calling manager.createIdentity...');
      const result = await manager.createIdentity(mnemonic, password);
      console.log('[useUnifiedIdentity] manager.createIdentity done');
      console.log('[useUnifiedIdentity] result identity:', {
        bitcoinAddress: result.identity.bitcoin.firstAddress,
        nostrNpub: result.identity.nostr.npub,
        meshcoreNodeId: result.identity.meshcore.nodeId,
      });

      console.log('[useUnifiedIdentity] Updating state...');
      setStateWithLog({
        hasIdentity: true,
        isUnlocked: true,
        identity: manager.getIdentity(),
        publicIdentity: {
          bitcoin: result.identity.bitcoin,
          nostr: result.identity.nostr,
          meshcore: result.identity.meshcore,
        },
      });
      console.log('[useUnifiedIdentity] State updated');

      console.log('[useUnifiedIdentity] === createWallet END - returning mnemonic ===');
      return mnemonic;
    } catch (err) {
      console.error('[useUnifiedIdentity] === createWallet ERROR ===');
      console.error('[useUnifiedIdentity] Error:', err);
      handleError(err);
      throw err;
    } finally {
      console.log('[useUnifiedIdentity] Setting isLoading to false');
      setIsLoading(false);
    }
  }, [getManager, handleError, setStateWithLog]);

  /**
   * Restaure un wallet depuis un mnemonic existant.
   */
  const restoreWallet = useCallback(async (
    mnemonic: string,
    password: string
  ): Promise<void> => {
    console.log('[useUnifiedIdentity] === restoreWallet START ===');
    console.log('[useUnifiedIdentity] mnemonic length:', mnemonic.length);
    console.log('[useUnifiedIdentity] password length:', password.length);
    
    setIsLoading(true);
    setError(null);

    try {
      const manager = getManager();
      console.log('[useUnifiedIdentity] Calling manager.createIdentity for restore...');
      await manager.createIdentity(mnemonic, password);
      console.log('[useUnifiedIdentity] manager.createIdentity done');

      console.log('[useUnifiedIdentity] Updating state...');
      setStateWithLog({
        hasIdentity: true,
        isUnlocked: true,
        identity: manager.getIdentity(),
        publicIdentity: null, // Sera mis à jour par checkIdentity
      });
      console.log('[useUnifiedIdentity] === restoreWallet END ===');
    } catch (err) {
      console.error('[useUnifiedIdentity] === restoreWallet ERROR ===');
      console.error('[useUnifiedIdentity] Error:', err);
      handleError(err);
      throw err;
    } finally {
      console.log('[useUnifiedIdentity] Setting isLoading to false');
      setIsLoading(false);
    }
  }, [getManager, handleError, setStateWithLog]);

  /**
   * Déverrouille l'identité.
   */
  const unlock = useCallback(async (password: string): Promise<boolean> => {
    console.log('[useUnifiedIdentity] === unlock START ===');
    console.log('[useUnifiedIdentity] password length:', password.length);
    
    setIsLoading(true);
    setError(null);

    try {
      const manager = getManager();
      console.log('[useUnifiedIdentity] Calling manager.unlock...');
      const success = await manager.unlock(password);
      console.log('[useUnifiedIdentity] manager.unlock returned:', success);

      if (success) {
        console.log('[useUnifiedIdentity] Updating state (unlocked)');
        setStateWithLog(prev => ({
          ...prev,
          isUnlocked: true,
          identity: manager.getIdentity(),
        }));
      }

      console.log('[useUnifiedIdentity] === unlock END ===');
      return success;
    } catch (err) {
      console.error('[useUnifiedIdentity] === unlock ERROR ===');
      console.error('[useUnifiedIdentity] Error:', err);
      handleError(err);
      return false;
    } finally {
      console.log('[useUnifiedIdentity] Setting isLoading to false');
      setIsLoading(false);
    }
  }, [getManager, handleError, setStateWithLog]);

  /**
   * Verrouille l'identité.
   */
  const lock = useCallback(() => {
    console.log('[useUnifiedIdentity] === lock CALLED ===');
    const manager = getManager();
    manager.lock();
    console.log('[useUnifiedIdentity] Manager locked');

    setStateWithLog(prev => ({
      ...prev,
      isUnlocked: false,
      identity: null,
    }));
    console.log('[useUnifiedIdentity] State updated (locked)');
  }, [getManager, setStateWithLog]);

  /**
   * Exporte un backup chiffré.
   */
  const exportBackup = useCallback(async (password: string): Promise<string> => {
    console.log('[useUnifiedIdentity] === exportBackup START ===');
    setIsLoading(true);
    setError(null);

    try {
      const manager = getManager();
      console.log('[useUnifiedIdentity] Calling manager.exportBackup...');
      const backup = await manager.exportBackup(password);
      console.log('[useUnifiedIdentity] === exportBackup END ===');
      return backup;
    } catch (err) {
      console.error('[useUnifiedIdentity] === exportBackup ERROR ===');
      console.error('[useUnifiedIdentity] Error:', err);
      handleError(err);
      throw err;
    } finally {
      console.log('[useUnifiedIdentity] Setting isLoading to false');
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
    console.log('[useUnifiedIdentity] === importBackup START ===');
    console.log('[useUnifiedIdentity] backupJson length:', backupJson.length);
    
    setIsLoading(true);
    setError(null);

    try {
      const manager = getManager();
      console.log('[useUnifiedIdentity] Calling manager.importBackup...');
      await manager.importBackup(backupJson, password);
      console.log('[useUnifiedIdentity] manager.importBackup done');

      console.log('[useUnifiedIdentity] Updating state...');
      setStateWithLog({
        hasIdentity: true,
        isUnlocked: true,
        identity: manager.getIdentity(),
        publicIdentity: null,
      });
      console.log('[useUnifiedIdentity] === importBackup END ===');
    } catch (err) {
      console.error('[useUnifiedIdentity] === importBackup ERROR ===');
      console.error('[useUnifiedIdentity] Error:', err);
      handleError(err);
      throw err;
    } finally {
      console.log('[useUnifiedIdentity] Setting isLoading to false');
      setIsLoading(false);
    }
  }, [getManager, handleError, setStateWithLog]);

  /**
   * Migre depuis l'ancien système.
   */
  const migrateFromLegacy = useCallback(async (
    walletMnemonic: string,
    nostrPrivkey: string,
    password: string
  ): Promise<void> => {
    console.log('[useUnifiedIdentity] === migrateFromLegacy START ===');
    console.log('[useUnifiedIdentity] walletMnemonic length:', walletMnemonic.length);
    console.log('[useUnifiedIdentity] nostrPrivkey length:', nostrPrivkey.length);
    
    setIsLoading(true);
    setError(null);

    try {
      const manager = getManager();
      console.log('[useUnifiedIdentity] Calling manager.migrateFromLegacy...');
      await manager.migrateFromLegacy(walletMnemonic, nostrPrivkey, password);
      console.log('[useUnifiedIdentity] manager.migrateFromLegacy done');

      console.log('[useUnifiedIdentity] Updating state...');
      setStateWithLog({
        hasIdentity: true,
        isUnlocked: true,
        identity: manager.getIdentity(),
        publicIdentity: null,
      });
      console.log('[useUnifiedIdentity] === migrateFromLegacy END ===');
    } catch (err) {
      console.error('[useUnifiedIdentity] === migrateFromLegacy ERROR ===');
      console.error('[useUnifiedIdentity] Error:', err);
      handleError(err);
      throw err;
    } finally {
      console.log('[useUnifiedIdentity] Setting isLoading to false');
      setIsLoading(false);
    }
  }, [getManager, handleError, setStateWithLog]);

  /**
   * Supprime l'identité.
   */
  const deleteIdentity = useCallback(async (): Promise<void> => {
    console.log('[useUnifiedIdentity] === deleteIdentity START ===');
    setIsLoading(true);
    setError(null);

    try {
      const manager = getManager();
      console.log('[useUnifiedIdentity] Calling manager.deleteIdentity...');
      await manager.deleteIdentity();
      console.log('[useUnifiedIdentity] manager.deleteIdentity done');

      console.log('[useUnifiedIdentity] Resetting state...');
      setStateWithLog({
        hasIdentity: false,
        isUnlocked: false,
        identity: null,
        publicIdentity: null,
      });
      console.log('[useUnifiedIdentity] === deleteIdentity END ===');
    } catch (err) {
      console.error('[useUnifiedIdentity] === deleteIdentity ERROR ===');
      console.error('[useUnifiedIdentity] Error:', err);
      handleError(err);
      throw err;
    } finally {
      console.log('[useUnifiedIdentity] Setting isLoading to false');
      setIsLoading(false);
    }
  }, [getManager, handleError, setStateWithLog]);

  /**
   * Efface l'erreur.
   */
  const clearError = useCallback(() => {
    console.log('[useUnifiedIdentity] clearError called');
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
