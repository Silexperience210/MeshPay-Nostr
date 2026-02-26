import { useState, useEffect, useCallback } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import createContextHook from '@nkzw/create-context-hook';
import {
  generateMnemonic,
  validateMnemonic,
  deriveWalletInfo,
  deriveReceiveAddresses,
  shortenAddress,
  DerivedWalletInfo,
} from '@/utils/bitcoin';

const MNEMONIC_KEY = 'meshcore_wallet_mnemonic';
const WALLET_INITIALIZED_KEY = 'meshcore_wallet_initialized';

export interface WalletSeedState {
  mnemonic: string | null;
  walletInfo: DerivedWalletInfo | null;
  receiveAddresses: string[];
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
  const [isInitialized, setIsInitialized] = useState<boolean>(false);

  const loadQuery = useQuery({
    queryKey: ['wallet-seed-load'],
    queryFn: async () => {
      console.log('[WalletSeed-Web] Loading stored mnemonic from localStorage...');
      try {
        const stored = localStorage.getItem(MNEMONIC_KEY);
        if (stored && validateMnemonic(stored)) {
          console.log('[WalletSeed-Web] Mnemonic valide chargé');
          return stored;
        }
        console.log('[WalletSeed-Web] No stored mnemonic found');
        return null;
      } catch (err) {
        console.log('[WalletSeed-Web] Error loading mnemonic:', err);
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
      setReceiveAddresses(deriveReceiveAddresses(loadQuery.data, 5));
      setIsInitialized(true);
    } else if (loadQuery.isFetched) {
      setIsInitialized(false);
    }
  }, [loadQuery.data, loadQuery.isFetched]);

  const generateMutation = useMutation({
    mutationFn: async (strength: 12 | 24) => {
      console.log('[WalletSeed-Web] Generating new wallet with', strength, 'words...');
      const newMnemonic = generateMnemonic(strength);
      localStorage.setItem(MNEMONIC_KEY, newMnemonic);
      localStorage.setItem(WALLET_INITIALIZED_KEY, 'true');
      console.log('[WalletSeed-Web] Saved to localStorage');
      return newMnemonic;
    },
    onSuccess: (newMnemonic) => {
      console.log('[WalletSeed-Web] Generation successful, updating state...');
      setMnemonic(newMnemonic);
      const info = deriveWalletInfo(newMnemonic);
      setWalletInfo(info);
      setReceiveAddresses(deriveReceiveAddresses(newMnemonic, 5));
      setIsInitialized(true);
    },
    onError: (err: any) => {
      console.error('[WalletSeed-Web] Generation error:', err);
    },
  });

  const importMutation = useMutation({
    mutationFn: async (importedMnemonic: string) => {
      console.log('[WalletSeed-Web] Importing wallet...');
      const trimmed = importedMnemonic.trim().toLowerCase();
      if (!validateMnemonic(trimmed)) {
        throw new Error('Invalid mnemonic phrase');
      }
      localStorage.setItem(MNEMONIC_KEY, trimmed);
      localStorage.setItem(WALLET_INITIALIZED_KEY, 'true');
      console.log('[WalletSeed-Web] Imported wallet saved');
      return trimmed;
    },
    onSuccess: (importedMnemonic) => {
      setMnemonic(importedMnemonic);
      const info = deriveWalletInfo(importedMnemonic);
      setWalletInfo(info);
      setReceiveAddresses(deriveReceiveAddresses(importedMnemonic, 5));
      setIsInitialized(true);
    },
    onError: (err) => {
      console.log('[WalletSeed-Web] Import error:', err);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      console.log('[WalletSeed-Web] Deleting wallet...');
      localStorage.removeItem(MNEMONIC_KEY);
      localStorage.removeItem(WALLET_INITIALIZED_KEY);
      console.log('[WalletSeed-Web] Wallet deleted');
    },
    onSuccess: () => {
      setMnemonic(null);
      setWalletInfo(null);
      setReceiveAddresses([]);
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
