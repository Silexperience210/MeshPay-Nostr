/**
 * WalletSeedProvider — Couche de compatibilité vers Zustand
 *
 * Ce fichier conserve la même interface publique qu'avant
 * (WalletSeedContext, useWalletSeed, WalletSeedState) mais délègue
 * toute la logique au walletStore Zustand.
 *
 * Cela permet à tous les composants existants (tabs, providers) de continuer
 * à importer { useWalletSeed } sans modification.
 *
 * Les fonctions crypto standalone (exportWalletEncrypted, importWalletDecrypted)
 * sont ré-exportées depuis walletStore pour rétro-compatibilité.
 */

import createContextHook from '@nkzw/create-context-hook';
import { useWalletStore, exportWalletEncrypted, importWalletDecrypted } from '@/stores/walletStore';
import type { DerivedWalletInfo } from '@/utils/bitcoin';

// ─── Ré-exports des fonctions crypto standalone ───────────────────────────────

export { exportWalletEncrypted, importWalletDecrypted };

// ─── Interface publique (inchangée) ──────────────────────────────────────────

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

// ─── Thin wrapper → Zustand walletStore ──────────────────────────────────────

export const [WalletSeedContext, useWalletSeed] = createContextHook((): WalletSeedState => {
  const store = useWalletStore();

  return {
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
    generateNewWallet: (strength?: 12 | 24) => { store.generateWallet(strength); },
    importWallet: (mnemonic: string) => { store.importWallet(mnemonic); },
    deleteWallet: () => { store.deleteWallet(); },
    getFormattedAddress: store.getFormattedAddress,
    exportWallet: store.exportWallet,
    importEncryptedWallet: (backupJson: string, password: string) => {
      store.importEncryptedWallet(backupJson, password);
    },
  };
});
