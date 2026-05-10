/**
 * Compat Layer - Providers de compatibilité pour transition Zustand
 * 
 * Ces providers permettent une migration progressive depuis les anciens Context Providers
 * vers les stores Zustand sans casser les composants existants.
 * 
 * Usage: Remplacer les imports dans app/_layout.tsx par ceux-ci
 * puis migrer les composants un par un vers les hooks Zustand.
 */

import React, { createContext, useContext, ReactNode } from 'react';
import {
  useWalletStore,
  useSettingsStore,
  WalletState,
  SettingsState,
  AppSettings,
} from './index';

// ─── Wallet Compat Context ───────────────────────────────────────────────────

interface WalletCompatContextValue {
  mnemonic: string | null;
  walletInfo: WalletState['walletInfo'];
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
  exportWallet: (password: string) => Promise<string>;
  importEncryptedWallet: (backupJson: string, password: string) => void;
}

const WalletCompatContext = createContext<WalletCompatContextValue | null>(null);

export function WalletCompatProvider({ children }: { children: ReactNode }) {
  const store = useWalletStore();

  const value: WalletCompatContextValue = {
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
    generateNewWallet: (strength?: 12 | 24) => {
      store.generateWallet(strength);
    },
    importWallet: (mnemonic: string) => {
      store.importWallet(mnemonic);
    },
    deleteWallet: () => {
      store.deleteWallet();
    },
    getFormattedAddress: store.getFormattedAddress,
    exportWallet: store.exportWallet,
    importEncryptedWallet: (backupJson: string, password: string) => {
      store.importEncryptedWallet(backupJson, password);
    },
  };

  return (
    <WalletCompatContext.Provider value={value}>
      {children}
    </WalletCompatContext.Provider>
  );
}

export function useWalletCompat() {
  const context = useContext(WalletCompatContext);
  if (!context) {
    throw new Error('useWalletCompat must be used within WalletCompatProvider');
  }
  return context;
}

// ─── Settings Compat Context ─────────────────────────────────────────────────

interface SettingsCompatContextValue {
  settings: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  getMempoolUrl: () => string;
  getCashuMintUrl: () => string;
  getActiveRelayUrls: () => string[];
  resetToDefaults: () => void;
  isInternetMode: boolean;
  isLoRaMode: boolean;
  isBridgeMode: boolean;
  isLoading: boolean;
  isSaving: boolean;
}

const SettingsCompatContext = createContext<SettingsCompatContextValue | null>(null);

export function SettingsCompatProvider({ children }: { children: ReactNode }) {
  const store = useSettingsStore();

  const value: SettingsCompatContextValue = {
    settings: {
      connectionMode: store.connectionMode,
      language: store.language,
      onboardingLangDone: store.onboardingLangDone,
      mempoolUrl: store.mempoolUrl,
      customMempoolUrl: store.customMempoolUrl,
      useCustomMempool: store.useCustomMempool,
      defaultCashuMint: store.defaultCashuMint,
      fallbackCashuMint: store.fallbackCashuMint,
      customCashuMint: store.customCashuMint,
      useCustomCashuMint: store.useCustomCashuMint,
      bitcoinNetwork: store.bitcoinNetwork,
      fiatCurrency: store.fiatCurrency,
      autoSyncInterval: store.autoSyncInterval,
      autoRelay: store.autoRelay,
      notifications: store.notifications,
      shareLocation: store.shareLocation,
      nostrRelays: store.nostrRelays,
    },
    updateSettings: store.updateSettings,
    getMempoolUrl: store.getMempoolUrl,
    getCashuMintUrl: store.getCashuMintUrl,
    getActiveRelayUrls: store.getActiveRelayUrls,
    resetToDefaults: store.resetToDefaults,
    isInternetMode: store.isInternetMode(),
    isLoRaMode: store.isLoRaMode(),
    isBridgeMode: store.isBridgeMode(),
    isLoading: store.isLoading,
    isSaving: store.isSaving,
  };

  return (
    <SettingsCompatContext.Provider value={value}>
      {children}
    </SettingsCompatContext.Provider>
  );
}

export function useSettingsCompat() {
  const context = useContext(SettingsCompatContext);
  if (!context) {
    throw new Error('useSettingsCompat must be used within SettingsCompatProvider');
  }
  return context;
}
