/**
 * Wallet Store (Web) — persistance SESSION-ONLY.
 *
 * Le web n'a pas d'équivalent SecureStore / Keystore. Écrire la seed BIP39
 * en clair dans `sessionStorage` l'exposerait à tout script tiers (XSS, ext.
 * navigateur, dev tools d'un autre profil OS).
 *
 * Contrainte de sécurité retenue : utiliser `sessionStorage` à la place.
 * Le wallet reste utilisable pendant la session de l'onglet mais disparaît
 * à la fermeture. Pour une persistance durable, l'utilisateur doit passer
 * par l'app mobile (Android / iOS) qui chiffre via le Keystore natif.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
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

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WalletState {
  // State
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
  _hasHydrated: boolean;

  // Actions
  generateWallet: (strength?: 12 | 24) => Promise<void>;
  importWallet: (mnemonic: string) => Promise<void>;
  deleteWallet: () => Promise<void>;
  getFormattedAddress: () => string;
  setHasHydrated: (hasHydrated: boolean) => void;
  
  // Internal
  _setWalletData: (mnemonic: string) => void;
  _clearWalletData: () => void;
  _setGenerating: (generating: boolean) => void;
  _setImporting: (importing: boolean) => void;
  _setGenerateError: (error: Error | null) => void;
  _setImportError: (error: Error | null) => void;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      // Initial state
      mnemonic: null,
      walletInfo: null,
      receiveAddresses: [],
      changeAddresses: [],
      isInitialized: false,
      isLoading: true,
      isGenerating: false,
      isImporting: false,
      generateError: null,
      importError: null,
      _hasHydrated: false,

      // Actions
      generateWallet: async (strength: 12 | 24 = 12) => {
        console.log('[WalletStore-Web] Generating new wallet with', strength, 'words...');
        get()._setGenerating(true);
        get()._setGenerateError(null);

        try {
          const newMnemonic = generateMnemonic(strength);
          console.log('[WalletStore-Web] Mnemonic generated, saving to sessionStorage...');
          
          sessionStorage.setItem(MNEMONIC_KEY, newMnemonic);
          sessionStorage.setItem(WALLET_INITIALIZED_KEY, 'true');
          
          console.log('[WalletStore-Web] Saved to sessionStorage');
          
          get()._setWalletData(newMnemonic);
          console.log('[WalletStore-Web] Wallet initialized successfully');
        } catch (error: any) {
          console.error('[WalletStore-Web] Generation error:', error);
          get()._setGenerateError(error);
          throw error;
        } finally {
          get()._setGenerating(false);
        }
      },

      importWallet: async (importedMnemonic: string) => {
        console.log('[WalletStore-Web] Importing wallet...');
        get()._setImporting(true);
        get()._setImportError(null);

        try {
          const trimmed = importedMnemonic.trim().toLowerCase();
          if (!validateMnemonic(trimmed)) {
            throw new Error('Phrase mnémonique invalide (vérifiez les mots et l\'ordre)');
          }

          const wordCount = trimmed.split(/\s+/).length;
          if (wordCount !== 12 && wordCount !== 24) {
            throw new Error(`Longueur invalide : ${wordCount} mots (12 ou 24 requis)`);
          }
          
          sessionStorage.setItem(MNEMONIC_KEY, trimmed);
          sessionStorage.setItem(WALLET_INITIALIZED_KEY, 'true');
          console.log('[WalletStore-Web] Imported wallet saved to sessionStorage');
          
          get()._setWalletData(trimmed);
        } catch (error: any) {
          console.error('[WalletStore-Web] Import error:', error);
          get()._setImportError(error);
          throw error;
        } finally {
          get()._setImporting(false);
        }
      },

      deleteWallet: async () => {
        console.log('[WalletStore-Web] Deleting wallet...');
        try {
          sessionStorage.removeItem(MNEMONIC_KEY);
          sessionStorage.removeItem(WALLET_INITIALIZED_KEY);
          console.log('[WalletStore-Web] Wallet deleted');
          
          get()._clearWalletData();
        } catch (error) {
          console.error('[WalletStore-Web] Delete error:', error);
          throw error;
        }
      },

      getFormattedAddress: () => {
        const { walletInfo } = get();
        if (walletInfo?.firstReceiveAddress) {
          return shortenAddress(walletInfo.firstReceiveAddress);
        }
        return 'No wallet';
      },

      setHasHydrated: (hasHydrated: boolean) => {
        set({ _hasHydrated: hasHydrated });
      },

      // Internal actions
      _setWalletData: (mnemonic: string) => {
        const info = deriveWalletInfo(mnemonic);
        set({
          mnemonic,
          walletInfo: info,
          receiveAddresses: deriveReceiveAddresses(mnemonic, 5),
          changeAddresses: [], // Pas besoin sur web
          isInitialized: true,
        });
      },

      _clearWalletData: () => {
        set({
          mnemonic: null,
          walletInfo: null,
          receiveAddresses: [],
          changeAddresses: [],
          isInitialized: false,
        });
      },

      _setGenerating: (generating: boolean) => set({ isGenerating: generating }),
      _setImporting: (importing: boolean) => set({ isImporting: importing }),
      _setGenerateError: (error: Error | null) => set({ generateError: error }),
      _setImportError: (error: Error | null) => set({ importError: error }),
    }),
    {
      name: 'wallet-storage-web',
      storage: createJSONStorage(() => sessionStorage),
      onRehydrateStorage: () => (state, error) => {
        console.log('[WalletStore-Web] Rehydrated from storage', { hasState: !!state, error });
        // FIX: Toujours marquer comme hydraté pour éviter le freeze
        if (state) {
          state.setHasHydrated(true);
          if (state.mnemonic) {
            state._setWalletData(state.mnemonic);
          }
        }
      },
      partialize: (state) => ({
        mnemonic: state.mnemonic,
        isInitialized: state.isInitialized,
        _hasHydrated: state._hasHydrated,
      }),
    }
  )
);

// ─── Hooks utilitaires ───────────────────────────────────────────────────────

export function useWalletInitialized() {
  return useWalletStore((state) => state.isInitialized);
}

export function useWalletLoading() {
  return useWalletStore((state) => state.isLoading);
}

export function useWalletMnemonic() {
  return useWalletStore((state) => state.mnemonic);
}

export function useWalletInfo() {
  return useWalletStore((state) => state.walletInfo);
}

export function useReceiveAddresses() {
  return useWalletStore((state) => state.receiveAddresses);
}

export function useChangeAddresses() {
  return useWalletStore((state) => state.changeAddresses);
}

export function useWalletActions() {
  const store = useWalletStore();
  return {
    generateWallet: store.generateWallet,
    importWallet: store.importWallet,
    deleteWallet: store.deleteWallet,
    getFormattedAddress: store.getFormattedAddress,
  };
}

// Fonctions d'export/import chiffré non disponibles sur web
export function exportWalletEncrypted(mnemonic: string, password: string): string {
  throw new Error('Export chiffré non disponible sur la version web');
}

export function importWalletDecrypted(backupJson: string, password: string): string {
  throw new Error('Import chiffré non disponible sur la version web');
}
