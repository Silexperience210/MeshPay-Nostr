import { useState, useEffect, useCallback } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import createContextHook from '@nkzw/create-context-hook';
import {
  generateMnemonic,
  validateMnemonic,
  deriveWalletInfo,
  deriveReceiveAddresses,
  deriveChangeAddresses,
  shortenAddress,
  DerivedWalletInfo,
} from '@/utils/bitcoin';

const MNEMONIC_KEY = 'meshcore_wallet_mnemonic';
const WALLET_INITIALIZED_KEY = 'meshcore_wallet_initialized';

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
      console.log('[WalletSeed] Loading stored mnemonic...');
      try {
        // 1. Essayer SecureStore (Android Keystore / iOS Keychain)
        let stored = await SecureStore.getItemAsync(MNEMONIC_KEY);

        if (stored) {
          console.log('[WalletSeed] Mnemonic trouvé dans SecureStore (TEE/Keychain)');
        } else {
          // 2. Migration unique : si l'ancienne version avait stocké dans AsyncStorage non chiffré,
          //    migrer vers SecureStore et supprimer l'entrée non chiffrée.
          const legacy = await AsyncStorage.getItem(MNEMONIC_KEY);
          if (legacy && validateMnemonic(legacy)) {
            console.warn('[WalletSeed] Migration : mnemonic non chiffré détecté dans AsyncStorage, migration vers SecureStore...');
            await SecureStore.setItemAsync(MNEMONIC_KEY, legacy);
            await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
            await AsyncStorage.removeItem(MNEMONIC_KEY);
            await AsyncStorage.removeItem(WALLET_INITIALIZED_KEY);
            console.log('[WalletSeed] Migration réussie — AsyncStorage nettoyé');
            stored = legacy;
          }
        }

        if (stored && validateMnemonic(stored)) {
          console.log('[WalletSeed] Mnemonic valide chargé');
          return stored;
        }
        console.log('[WalletSeed] No stored mnemonic found');
        return null;
      } catch (err) {
        console.log('[WalletSeed] Error loading mnemonic:', err);
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
      setIsInitialized(false);
    }
  }, [loadQuery.data, loadQuery.isFetched]);

  const generateMutation = useMutation({
    mutationFn: async (strength: 12 | 24) => {
      console.log('[WalletSeed] Generating new wallet with', strength, 'words...');
      try {
        const newMnemonic = generateMnemonic(strength);
        console.log('[WalletSeed] Mnemonic generated, saving...');
        
        // Stocker UNIQUEMENT dans SecureStore (Android Keystore / iOS Keychain)
        // Pas de fallback AsyncStorage — il ne chiffre pas les données
        await SecureStore.setItemAsync(MNEMONIC_KEY, newMnemonic);
        await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
        console.log('[WalletSeed] Saved to SecureStore (TEE/Keychain)');
        
        return newMnemonic;
      } catch (error: any) {
        console.error('[WalletSeed] Error in mutationFn:', error);
        throw new Error(`Failed to generate wallet: ${error.message || error}`);
      }
    },
    onSuccess: (newMnemonic) => {
      console.log('[WalletSeed] Generation successful, updating state...');
      setMnemonic(newMnemonic);
      const info = deriveWalletInfo(newMnemonic);
      setWalletInfo(info);
      setReceiveAddresses(deriveReceiveAddresses(newMnemonic, 20));
      setChangeAddresses(deriveChangeAddresses(newMnemonic, 20));
      setIsInitialized(true);
      console.log('[WalletSeed] Wallet initialized successfully');
    },
    onError: (err: any) => {
      console.error('[WalletSeed] ❌ Generation error:', err);
      console.error('[WalletSeed] Error details:', JSON.stringify(err, null, 2));
      // L'erreur sera affichée dans Settings via Alert
    },
  });

  const importMutation = useMutation({
    mutationFn: async (importedMnemonic: string) => {
      console.log('[WalletSeed] Importing wallet...');
      const trimmed = importedMnemonic.trim().toLowerCase();
      if (!validateMnemonic(trimmed)) {
        throw new Error('Phrase mnémonique invalide (vérifiez les mots et l\'ordre)');
      }

      const wordCount = trimmed.split(/\s+/).length;
      if (wordCount !== 12 && wordCount !== 24) {
        throw new Error(`Longueur invalide : ${wordCount} mots (12 ou 24 requis)`);
      }
      if (wordCount === 12) {
        console.warn('[WalletSeed] Import 12 mots (128-bit) — envisagez 24 mots pour plus de sécurité');
      }
      
      // Stocker UNIQUEMENT dans SecureStore (Android Keystore / iOS Keychain)
      await SecureStore.setItemAsync(MNEMONIC_KEY, trimmed);
      await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
      console.log('[WalletSeed] Imported wallet saved to SecureStore (TEE/Keychain)');
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
      console.log('[WalletSeed] Import error:', err);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      console.log('[WalletSeed] Deleting wallet...');
      await SecureStore.deleteItemAsync(MNEMONIC_KEY);
      await SecureStore.deleteItemAsync(WALLET_INITIALIZED_KEY);
      await AsyncStorage.removeItem(MNEMONIC_KEY);
      await AsyncStorage.removeItem(WALLET_INITIALIZED_KEY);
      console.log('[WalletSeed] Wallet deleted');
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
  };
});
