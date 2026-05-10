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
  // Sélecteurs granulaires pour éviter la souscription complète au store
  const mnemonic = useWalletStore(s => s.mnemonic);
  const walletInfo = useWalletStore(s => s.walletInfo);
  const receiveAddresses = useWalletStore(s => s.receiveAddresses);
  const changeAddresses = useWalletStore(s => s.changeAddresses);
  const isInitialized = useWalletStore(s => s.isInitialized);
  const isLoading = useWalletStore(s => s.isLoading);
  const isGenerating = useWalletStore(s => s.isGenerating);
  const isImporting = useWalletStore(s => s.isImporting);
  const generateError = useWalletStore(s => s.generateError);
  const importError = useWalletStore(s => s.importError);
  const getFormattedAddress = useWalletStore(s => s.getFormattedAddress);
  const generateWallet = useWalletStore(s => s.generateWallet);
  const importWalletFn = useWalletStore(s => s.importWallet);
  const deleteWalletFn = useWalletStore(s => s.deleteWallet);
  const importEncryptedWalletFn = useWalletStore(s => s.importEncryptedWallet);

  const generateNewWallet = useCallback(async (strength?: 12 | 24) => {
    await generateWallet(strength);
  }, [generateWallet]);

  const importWallet = useCallback(async (mnemonic: string) => {
    await importWalletFn(mnemonic);
  }, [importWalletFn]);

  const deleteWallet = useCallback(async () => {
    await deleteWalletFn();
  }, [deleteWalletFn]);

  const exportWallet = useCallback(async (password: string) => {
    if (!mnemonic) throw new Error('Aucun wallet à exporter');
    return await exportWalletEncrypted(mnemonic, password);
  }, [mnemonic]);

  const importEncryptedWallet = useCallback(async (backupJson: string, password: string) => {
    await importEncryptedWalletFn(backupJson, password);
  }, [importEncryptedWalletFn]);

  return useMemo(() => ({
    mnemonic,
    walletInfo,
    receiveAddresses,
    changeAddresses,
    isInitialized,
    isLoading,
    isGenerating,
    isImporting,
    generateError,
    importError,
    generateNewWallet,
    importWallet,
    deleteWallet,
    getFormattedAddress,
    exportWallet,
    importEncryptedWallet,
  }), [
    mnemonic, walletInfo, receiveAddresses, changeAddresses,
    isInitialized, isLoading, isGenerating, isImporting,
    generateError, importError, getFormattedAddress,
    generateNewWallet, importWallet, deleteWallet, exportWallet, importEncryptedWallet,
  ]);
});
