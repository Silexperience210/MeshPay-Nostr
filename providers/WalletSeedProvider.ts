import { useState, useEffect, useCallback } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import createContextHook from '@nkzw/create-context-hook';
// @ts-ignore — subpath exports
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
// @ts-ignore — subpath exports
import { sha256 } from '@noble/hashes/sha2.js';
// @ts-ignore — subpath exports
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes';
import {
  generateMnemonic,
  validateMnemonic,
  deriveWalletInfo,
  deriveReceiveAddresses,
  deriveChangeAddresses,
  shortenAddress,
  DerivedWalletInfo,
} from '@/utils/bitcoin';
import { logger } from '@/utils/logger';

const MNEMONIC_KEY = 'meshcore_wallet_mnemonic';
const WALLET_INITIALIZED_KEY = 'meshcore_wallet_initialized';

// ─── Wallet backup chiffré (PBKDF2 + AES-256-GCM) ────────────────────────────

interface EncryptedWalletBackup {
  /** Version du format */
  v: 1;
  /** Sel PBKDF2 hex (32 bytes) */
  salt: string;
  /** IV AES-GCM hex (12 bytes) */
  iv: string;
  /** Mnemonic chiffré + tag GCM hex */
  ct: string;
}

/**
 * Chiffre le mnemonic avec un mot de passe.
 * PBKDF2-SHA256 (100k itérations) → clé AES-256-GCM.
 * Retourne un JSON string prêt à copier/partager.
 */
export function exportWalletEncrypted(mnemonic: string, password: string): string {
  if (!mnemonic || !password) throw new Error('Mnemonic et mot de passe requis');

  const salt = randomBytes(32);
  const iv = randomBytes(12);

  // Dérivation de clé : PBKDF2(password, salt, 100_000, SHA-256) → 32 bytes
  const key = pbkdf2(sha256, new TextEncoder().encode(password), salt, { c: 100_000, dkLen: 32 });

  // Chiffrement AES-256-GCM
  const plaintext = new TextEncoder().encode(mnemonic);
  const ciphertext = gcm(key, iv).encrypt(plaintext); // inclut tag GCM (16 bytes en fin)

  const backup: EncryptedWalletBackup = {
    v: 1,
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ct: bytesToHex(ciphertext),
  };
  return JSON.stringify(backup);
}

/**
 * Déchiffre un backup avec le mot de passe.
 * @throws si le mot de passe est incorrect (tag GCM invalide) ou format invalide.
 */
export function importWalletDecrypted(backupJson: string, password: string): string {
  let backup: EncryptedWalletBackup;
  try {
    backup = JSON.parse(backupJson) as EncryptedWalletBackup;
  } catch {
    throw new Error('Format de backup invalide — JSON attendu');
  }

  if (backup.v !== 1 || !backup.salt || !backup.iv || !backup.ct) {
    throw new Error('Format de backup invalide — champs manquants');
  }

  const salt = hexToBytes(backup.salt);
  const iv = hexToBytes(backup.iv);
  const ciphertext = hexToBytes(backup.ct);

  const key = pbkdf2(sha256, new TextEncoder().encode(password), salt, { c: 100_000, dkLen: 32 });

  try {
    const plaintext = gcm(key, iv).decrypt(ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('Mot de passe incorrect ou backup corrompu');
  }
}

export interface WalletSeedState {
  mnemonic: string | null;
  walletInfo: DerivedWalletInfo | null;
  receiveAddresses: string[];
  changeAddresses: string[];
  isInitialized: boolean;
  isLoading: boolean;
  isGenerating: boolean;
  isImporting: boolean;
  generateError: Error | null;
  importError: Error | null;
  generateNewWallet: (strength?: 12 | 24) => void;
  importWallet: (mnemonic: string) => void;
  deleteWallet: () => void;
  getFormattedAddress: () => string;
  /** Exporte le mnemonic chiffré avec un mot de passe (PBKDF2 + AES-GCM). Retourne JSON string. */
  exportWallet: (password: string) => string;
  /** Importe un backup chiffré. Lance une erreur si mot de passe incorrect. */
  importEncryptedWallet: (backupJson: string, password: string) => void;
}

export const [WalletSeedContext, useWalletSeed] = createContextHook(() => {
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [walletInfo, setWalletInfo] = useState<DerivedWalletInfo | null>(null);
  const [receiveAddresses, setReceiveAddresses] = useState<string[]>([]);
  const [changeAddresses, setChangeAddresses] = useState<string[]>([]);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);

  const loadQuery = useQuery({
    queryKey: ['wallet-seed-load'],
    queryFn: async () => {
      logger.info('[WalletSeed] Loading stored mnemonic...');
      try {
        // 1. Essayer SecureStore (Android Keystore / iOS Keychain)
        let stored = await SecureStore.getItemAsync(MNEMONIC_KEY);

        if (stored) {
          logger.info('[WalletSeed] Mnemonic trouvé dans SecureStore (TEE/Keychain)');
        } else {
          // 2. Migration unique : si l'ancienne version avait stocké dans AsyncStorage non chiffré,
          //    migrer vers SecureStore et supprimer l'entrée non chiffrée.
          const legacy = await AsyncStorage.getItem(MNEMONIC_KEY);
          if (legacy && validateMnemonic(legacy)) {
            logger.warn('[WalletSeed] Migration : mnemonic non chiffré détecté dans AsyncStorage, migration vers SecureStore...');
            try {
              await SecureStore.setItemAsync(MNEMONIC_KEY, legacy);
              await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');

              // Vérification avant suppression : relire depuis SecureStore pour confirmer
              // que l'écriture est effective (Android Keystore peut retarder le flush)
              const written = await SecureStore.getItemAsync(MNEMONIC_KEY);
              if (written !== legacy) {
                throw new Error('Vérification SecureStore échouée — valeur non conforme');
              }

              // Écriture confirmée : suppression sécurisée de la copie non chiffrée
              await AsyncStorage.removeItem(MNEMONIC_KEY);
              await AsyncStorage.removeItem(WALLET_INITIALIZED_KEY);
              logger.info('[WalletSeed] Migration réussie — AsyncStorage nettoyé');
              stored = legacy;
            } catch (migrationErr) {
              // Migration incomplète : AsyncStorage conservé intact (aucune perte de données)
              // Le prochain démarrage retentrera la migration
              logger.error('[WalletSeed] Migration échouée — AsyncStorage conservé:', migrationErr);
            }
          }
        }

        if (stored && validateMnemonic(stored)) {
          logger.secure('info', '[WalletSeed] Mnemonic valide chargé');
          return stored;
        }
        logger.info('[WalletSeed] No stored mnemonic found');
        return null;
      } catch (err) {
        logger.error('[WalletSeed] Error loading mnemonic:', err);
        return null;
      }
    },
    staleTime: Infinity,
  });

  useEffect(() => {
    if (loadQuery.data) {
      setMnemonic(loadQuery.data);
      const info = deriveWalletInfo(loadQuery.data);
      setWalletInfo(info);
      setReceiveAddresses(deriveReceiveAddresses(loadQuery.data, 20));
      setChangeAddresses(deriveChangeAddresses(loadQuery.data, 20));
      setIsInitialized(true);
    } else if (loadQuery.isFetched) {
      // Aucun wallet existant — auto-générer pour que l'identité MeshCore soit dispo immédiatement
      // L'utilisateur peut sauvegarder ou remplacer la phrase depuis les Paramètres
      logger.info('[WalletSeed] Aucun wallet trouvé — génération automatique...');
      (async () => {
        try {
          const newMnemonic = generateMnemonic(12);
          await SecureStore.setItemAsync(MNEMONIC_KEY, newMnemonic);
          await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
          setMnemonic(newMnemonic);
          const info = deriveWalletInfo(newMnemonic);
          setWalletInfo(info);
          setReceiveAddresses(deriveReceiveAddresses(newMnemonic, 20));
          setChangeAddresses(deriveChangeAddresses(newMnemonic, 20));
          setIsInitialized(true);
          logger.info('[WalletSeed] Wallet auto-généré et sauvegardé');
        } catch (err) {
          logger.error('[WalletSeed] Erreur génération auto:', err);
          setIsInitialized(false);
        }
      })();
    }
  }, [loadQuery.data, loadQuery.isFetched]);

  const generateMutation = useMutation({
    mutationFn: async (strength: 12 | 24) => {
      logger.info('[WalletSeed] Generating new wallet...');
      try {
        const newMnemonic = generateMnemonic(strength);
        logger.secure('info', '[WalletSeed] Mnemonic generated, saving...');
        
        // Stocker UNIQUEMENT dans SecureStore (Android Keystore / iOS Keychain)
        // Pas de fallback AsyncStorage — il ne chiffre pas les données
        await SecureStore.setItemAsync(MNEMONIC_KEY, newMnemonic);
        await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
        logger.info('[WalletSeed] Saved to SecureStore (TEE/Keychain)');
        
        return newMnemonic;
      } catch (error: any) {
        logger.error('[WalletSeed] Error in mutationFn:', error);
        throw new Error(`Failed to generate wallet: ${error.message || error}`);
      }
    },
    onSuccess: (newMnemonic) => {
      logger.secure('info', '[WalletSeed] Generation successful, updating state...');
      setMnemonic(newMnemonic);
      const info = deriveWalletInfo(newMnemonic);
      setWalletInfo(info);
      setReceiveAddresses(deriveReceiveAddresses(newMnemonic, 20));
      setChangeAddresses(deriveChangeAddresses(newMnemonic, 20));
      setIsInitialized(true);
      logger.info('[WalletSeed] Wallet initialized successfully');
    },
    onError: (err: any) => {
      logger.error('[WalletSeed] ❌ Generation error:', err);
      // L'erreur sera affichée dans Settings via Alert
    },
  });

  const importMutation = useMutation({
    mutationFn: async (importedMnemonic: string) => {
      logger.info('[WalletSeed] Importing wallet...');
      const trimmed = importedMnemonic.trim().toLowerCase();
      if (!validateMnemonic(trimmed)) {
        throw new Error('Phrase mnémonique invalide (vérifiez les mots et l\'ordre)');
      }

      const wordCount = trimmed.split(/\s+/).length;
      if (wordCount !== 12 && wordCount !== 24) {
        throw new Error(`Longueur invalide : ${wordCount} mots (12 ou 24 requis)`);
      }
      if (wordCount === 12) {
        logger.warn('[WalletSeed] Import 12 mots (128-bit) — envisagez 24 mots pour plus de sécurité');
      }
      
      // Stocker UNIQUEMENT dans SecureStore (Android Keystore / iOS Keychain)
      await SecureStore.setItemAsync(MNEMONIC_KEY, trimmed);
      await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
      logger.info('[WalletSeed] Imported wallet saved to SecureStore (TEE/Keychain)');
      return trimmed;
    },
    onSuccess: (importedMnemonic) => {
      setMnemonic(importedMnemonic);
      const info = deriveWalletInfo(importedMnemonic);
      setWalletInfo(info);
      setReceiveAddresses(deriveReceiveAddresses(importedMnemonic, 20));
      setChangeAddresses(deriveChangeAddresses(importedMnemonic, 20));
      setIsInitialized(true);
    },
    onError: (err) => {
      logger.error('[WalletSeed] Import error:', err);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      logger.info('[WalletSeed] Deleting wallet...');
      await SecureStore.deleteItemAsync(MNEMONIC_KEY);
      await SecureStore.deleteItemAsync(WALLET_INITIALIZED_KEY);
      await AsyncStorage.removeItem(MNEMONIC_KEY);
      await AsyncStorage.removeItem(WALLET_INITIALIZED_KEY);
      logger.info('[WalletSeed] Wallet deleted');
    },
    onSuccess: () => {
      setMnemonic(null);
      setWalletInfo(null);
      setReceiveAddresses([]);
      setChangeAddresses([]);
      setIsInitialized(false);
    },
  });

  const generateNewWallet = useCallback((strength: 12 | 24 = 12) => {
    generateMutation.mutate(strength);
  }, [generateMutation]);

  const importWallet = useCallback((importedMnemonic: string) => {
    importMutation.mutate(importedMnemonic);
  }, [importMutation]);

  const deleteWallet = useCallback(() => {
    deleteMutation.mutate();
  }, [deleteMutation]);

  const getFormattedAddress = useCallback(() => {
    if (walletInfo?.firstReceiveAddress) {
      return shortenAddress(walletInfo.firstReceiveAddress);
    }
    return 'No wallet';
  }, [walletInfo]);

  const exportWallet = useCallback((password: string): string => {
    if (!mnemonic) throw new Error('Aucun wallet à exporter');
    return exportWalletEncrypted(mnemonic, password);
  }, [mnemonic]);

  const importEncryptedWallet = useCallback((backupJson: string, password: string) => {
    const decrypted = importWalletDecrypted(backupJson, password);
    importMutation.mutate(decrypted);
  }, [importMutation]);

  return {
    mnemonic,
    walletInfo,
    receiveAddresses,
    changeAddresses,
    isInitialized,
    isLoading: loadQuery.isLoading,
    isGenerating: generateMutation.isPending,
    isImporting: importMutation.isPending,
    generateError: generateMutation.error,
    importError: importMutation.error,
    generateNewWallet,
    importWallet,
    deleteWallet,
    getFormattedAddress,
    exportWallet,
    importEncryptedWallet,
  };
});
