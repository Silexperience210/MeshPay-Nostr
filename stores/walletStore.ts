/**
 * Wallet Store - Remplace WalletSeedProvider
 * Gère le mnemonic, les adresses et l'état du wallet avec persistance dans SecureStore
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Vérifier que le polyfill crypto est bien chargé avant d'importer @noble/hashes
const checkCryptoPolyfill = () => {
  const hasGlobalCrypto = typeof global !== 'undefined' && 
                          typeof (global as any).crypto === 'object' &&
                          typeof (global as any).crypto.getRandomValues === 'function';
  const hasGlobalThisCrypto = typeof globalThis !== 'undefined' && 
                              typeof (globalThis as any).crypto === 'object' &&
                              typeof (globalThis as any).crypto.getRandomValues === 'function';
  
  if (!hasGlobalCrypto && !hasGlobalThisCrypto) {
    console.error('[WalletStore] CRITICAL: crypto.getRandomValues not available!');
    console.error('[WalletStore] Polyfill should be loaded in app/_layout.tsx before any store import');
    throw new Error('crypto.getRandomValues must be defined. Import polyfills in _layout.tsx first.');
  }
  
  console.log('[WalletStore] Crypto polyfill check passed');
  return true;
};

// Vérifier avant d'importer les modules qui utilisent crypto
checkCryptoPolyfill();

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

// ─── Storage Adapter pour Zustand ────────────────────────────────────────────

/**
 * Storage adapter personnalisé qui utilise SecureStore pour le mnemonic
 * et AsyncStorage pour les métadonnées
 */
const secureWalletStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      // Récupérer le mnemonic depuis SecureStore
      const mnemonic = await SecureStore.getItemAsync(MNEMONIC_KEY);
      const initialized = await SecureStore.getItemAsync(WALLET_INITIALIZED_KEY);
      
      if (!mnemonic) {
        // Migration depuis AsyncStorage si nécessaire
        const legacy = await AsyncStorage.getItem(MNEMONIC_KEY);
        if (legacy && validateMnemonic(legacy)) {
          console.warn('[WalletStore] Migration : mnemonic non chiffré détecté, migration vers SecureStore...');
          await SecureStore.setItemAsync(MNEMONIC_KEY, legacy);
          await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
          const written = await SecureStore.getItemAsync(MNEMONIC_KEY);
          if (written === legacy) {
            await AsyncStorage.removeItem(MNEMONIC_KEY);
            await AsyncStorage.removeItem(WALLET_INITIALIZED_KEY);
            console.log('[WalletStore] Migration réussie');
            return JSON.stringify({
              state: {
                mnemonic: legacy,
                isInitialized: true,
                _hasHydrated: true,
              },
              version: 0,
            });
          }
        }
        // FIX: Retourner un état minimal pour premier démarrage (pas de freeze)
        return JSON.stringify({
          state: {
            mnemonic: null,
            isInitialized: false,
            _hasHydrated: true,
          },
          version: 0,
        });
      }

      return JSON.stringify({
        state: {
          mnemonic,
          isInitialized: initialized === 'true',
          _hasHydrated: true,
        },
        version: 0,
      });
    } catch (err) {
      console.error('[WalletStore] Error loading from secure storage:', err);
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      const parsed = JSON.parse(value);
      const { mnemonic, isInitialized } = parsed.state;
      
      if (mnemonic) {
        await SecureStore.setItemAsync(MNEMONIC_KEY, mnemonic);
        await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
      } else {
        await SecureStore.deleteItemAsync(MNEMONIC_KEY);
        await SecureStore.deleteItemAsync(WALLET_INITIALIZED_KEY);
      }
    } catch (err) {
      console.error('[WalletStore] Error saving to secure storage:', err);
    }
  },
  removeItem: async (name: string): Promise<void> => {
    await SecureStore.deleteItemAsync(MNEMONIC_KEY);
    await SecureStore.deleteItemAsync(WALLET_INITIALIZED_KEY);
    await AsyncStorage.removeItem(MNEMONIC_KEY);
    await AsyncStorage.removeItem(WALLET_INITIALIZED_KEY);
  },
};

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
  exportWallet: (password: string) => string;
  importEncryptedWallet: (backupJson: string, password: string) => Promise<void>;
  getFormattedAddress: () => string;
  setHasHydrated: (hasHydrated: boolean) => void;
  
  // Internal
  _setWalletData: (mnemonic: string) => void;
  _clearWalletData: () => void;
  _setLoading: (loading: boolean) => void;
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
        console.log('[WalletStore] === generateWallet START ===');
        console.log('[WalletStore] Generating new wallet with', strength, 'words...');
        
        try {
          get()._setGenerating(true);
          get()._setGenerateError(null);
          console.log('[WalletStore] State updated: isGenerating=true');

          console.log('[WalletStore] About to call generateMnemonic...');
          let newMnemonic: string;
          try {
            newMnemonic = generateMnemonic(strength);
            console.log('[WalletStore] generateMnemonic returned successfully');
          } catch (mnemonicErr: any) {
            console.error('[WalletStore] generateMnemonic FAILED:', mnemonicErr);
            throw mnemonicErr;
          }
          
          console.log('[WalletStore] Saving to SecureStore...');
          try {
            await SecureStore.setItemAsync(MNEMONIC_KEY, newMnemonic);
            await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
            console.log('[WalletStore] Saved to SecureStore OK');
          } catch (secureStoreErr: any) {
            console.error('[WalletStore] SecureStore FAILED:', secureStoreErr);
            throw secureStoreErr;
          }
          
          console.log('[WalletStore] Setting wallet data...');
          get()._setWalletData(newMnemonic);
          console.log('[WalletStore] Wallet initialized successfully');
        } catch (error: any) {
          console.error('[WalletStore] === generateWallet ERROR ===', error?.message || error);
          get()._setGenerateError(error instanceof Error ? error : new Error(String(error)));
          // Ne pas rethrow pour éviter de casser l'UI, l'erreur est dans generateError
        } finally {
          console.log('[WalletStore] === generateWallet FINALLY ===');
          get()._setGenerating(false);
        }
      },

      importWallet: async (importedMnemonic: string) => {
        console.log('[WalletStore] Importing wallet...');
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
          if (wordCount === 12) {
            console.warn('[WalletStore] Import 12 mots (128-bit) — envisagez 24 mots pour plus de sécurité');
          }
          
          await SecureStore.setItemAsync(MNEMONIC_KEY, trimmed);
          await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
          console.log('[WalletStore] Imported wallet saved to SecureStore (TEE/Keychain)');
          
          get()._setWalletData(trimmed);
        } catch (error: any) {
          console.error('[WalletStore] Import error:', error);
          get()._setImportError(error);
          throw error;
        } finally {
          get()._setImporting(false);
        }
      },

      deleteWallet: async () => {
        console.log('[WalletStore] Deleting wallet...');
        try {
          await SecureStore.deleteItemAsync(MNEMONIC_KEY);
          await SecureStore.deleteItemAsync(WALLET_INITIALIZED_KEY);
          await AsyncStorage.removeItem(MNEMONIC_KEY);
          await AsyncStorage.removeItem(WALLET_INITIALIZED_KEY);
          console.log('[WalletStore] Wallet deleted');
          
          get()._clearWalletData();
        } catch (error) {
          console.error('[WalletStore] Delete error:', error);
          throw error;
        }
      },

      exportWallet: (password: string): string => {
        const { mnemonic } = get();
        if (!mnemonic) throw new Error('Aucun wallet à exporter');
        return exportWalletEncrypted(mnemonic, password);
      },

      importEncryptedWallet: async (backupJson: string, password: string) => {
        const decrypted = importWalletDecrypted(backupJson, password);
        await get().importWallet(decrypted);
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
          receiveAddresses: deriveReceiveAddresses(mnemonic, 20),
          changeAddresses: deriveChangeAddresses(mnemonic, 20),
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

      _setLoading: (loading: boolean) => set({ isLoading: loading }),
      _setGenerating: (generating: boolean) => set({ isGenerating: generating }),
      _setImporting: (importing: boolean) => set({ isImporting: importing }),
      _setGenerateError: (error: Error | null) => set({ generateError: error }),
      _setImportError: (error: Error | null) => set({ importError: error }),
    }),
    {
      name: 'wallet-storage',
      storage: createJSONStorage(() => secureWalletStorage),
      onRehydrateStorage: () => (state, error) => {
        console.log('[WalletStore] Rehydrated from storage', { hasState: !!state, error });
        // FIX: Toujours marquer comme hydraté, même si pas de wallet (premier démarrage)
        // ou en cas d'erreur, pour éviter le freeze sur le splash screen
        if (state) {
          state.setHasHydrated(true);
          // Dériver les données du wallet après réhydratation
          if (state.mnemonic) {
            state._setWalletData(state.mnemonic);
          }
        }
      },
      // Ne pas persister ces champs dans le state Zustand (déjà dans SecureStore)
      partialize: (state) => ({
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
    exportWallet: store.exportWallet,
    importEncryptedWallet: store.importEncryptedWallet,
    getFormattedAddress: store.getFormattedAddress,
  };
}
