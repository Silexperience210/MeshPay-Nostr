import { useState } from 'react';
import createContextHook from '@nkzw/create-context-hook';

export interface DerivedWalletInfo {
  xpub: string;
  firstReceiveAddress: string;
  fingerprint: string;
}

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

export const [WalletSeedContext, useWalletSeed] = createContextHook((): WalletSeedState => {
  const [mnemonic] = useState<string | null>(null);
  const [walletInfo] = useState<DerivedWalletInfo | null>(null);
  const [receiveAddresses] = useState<string[]>([]);

  return {
    mnemonic,
    walletInfo,
    receiveAddresses,
    isInitialized: false,
    isLoading: false,
    isGenerating: false,
    isImporting: false,
    generateError: null,
    importError: null,
    generateNewWallet: () => console.log('[WalletSeed-Web] Not available on web'),
    importWallet: () => console.log('[WalletSeed-Web] Not available on web'),
    deleteWallet: () => console.log('[WalletSeed-Web] Not available on web'),
    getFormattedAddress: () => 'No wallet (web)',
  };
});
