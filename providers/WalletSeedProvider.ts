/**
 * WalletSeedProvider — Couche de compatibilité vers Zustand
 *
 * Ce fichier conserve la même interface publique qu'avant
 * (WalletSeedContext, useWalletSeed, WalletSeedState) mais délègue
 * toute la logique au walletStore Zustand.
 */

import { useMemo, useCallback } from 'react';
import createContextHook from '@nkzw/create-context-hook';
import { useWalletStore, exportWalletEncrypted, importWalletDecrypted } from '@/stores/walletStore';
import type { DerivedWalletInfo } from '@/utils/bitcoin';

// ─── Ré-exports des fonctions crypto standalone ───────────────────────────────

export { exportWalletEncrypted, importWalletDecrypted };

// ─── Interface publique ──────────────────────────────────────────────────────

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
  generateNewWallet: (strength?: 12 | 24) => Promise<void>;
  importWallet: (mnemonic: string) => Promise<void>;
  deleteWallet: () => Promise<void>;
  getFormattedAddress: () => string;
  /** Exporte le mnemonic chiffré avec un mot de passe (PBKDF2 + AES-GCM). Retourne Promise<JSON string>. */
  exportWallet: (password: string) => Promise<string>;
  /** Importe un backup chiffré. Lance une erreur si mot de passe incorrect. */
  importEncryptedWallet: (backupJson: string, password: string) => Promise<void>;
}

// ─── Thin wrapper → Zustand walletStore ──────────────────────────────────────

export const [WalletSeedContext, useWalletSeed] = createContextHook((): WalletSeedState => {
  const store = useWalletStore();

  const generateNewWallet = useCallback(async (strength?: 12 | 24) => {
    await store.generateWallet(strength);
  }, [store.generateWallet]);

  const importWallet = useCallback(async (mnemonic: string) => {
    await store.importWallet(mnemonic);
  }, [store.importWallet]);

  const deleteWallet = useCallback(async () => {
    await store.deleteWallet();
  }, [store.deleteWallet]);

  const exportWallet = useCallback(async (password: string) => {
    if (!store.mnemonic) throw new Error('Aucun wallet à exporter');
    return await exportWalletEncrypted(store.mnemonic, password);
  }, [store.mnemonic]);

  const importEncryptedWallet = useCallback(async (backupJson: string, password: string) => {
    await store.importEncryptedWallet(backupJson, password);
  }, [store.importEncryptedWallet]);

  return useMemo(() => ({
    mnemonic: store.mnemonic,
    walletInfo: store.walletInfo,
    receiveAddresses: store.receiveAddresses,
    changeAddresses: store.changeAddresses,
    isInitialized: store.isInitialized,
    isLoading: store.isLoading,
    isGenerating: store.isGenerating,
    isImporting: store.isImporting,
    generateError: store.generateError,
    importError: store.importError,
    generateNewWallet,
    importWallet,
    deleteWallet,
    getFormattedAddress: store.getFormattedAddress,
    exportWallet,
    importEncryptedWallet,
  }), [
    store.mnemonic, store.walletInfo, store.receiveAddresses, store.changeAddresses,
    store.isInitialized, store.isLoading, store.isGenerating, store.isImporting,
    store.generateError, store.importError, store.getFormattedAddress,
    generateNewWallet, importWallet, deleteWallet, exportWallet, importEncryptedWallet,
  ]);
});
