/**
 * Wallet Store - Remplace WalletSeedProvider
 * Gère le mnemonic, les adresses et l'état du wallet avec persistance dans SecureStore
 * 
 * Architecture: Les imports @noble/hashes sont retardés jusqu'au moment de l'utilisation
 * pour garantir que le polyfill crypto est bien chargé.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Hermès Engine - émission d'événements
import { hermes, EventType, Transport } from '@/engine';

// Types et fonctions Bitcoin qui ne dépendent pas de @noble/hashes
import type { DerivedWalletInfo } from '@/utils/bitcoin';

// Import différé de bitcoin.ts (qui utilise @noble/hashes)
let bitcoinModule: typeof import('@/utils/bitcoin') | null = null;

async function loadBitcoinModule() {
  if (!bitcoinModule) {
    if (__DEV__) console.log('[WalletStore] Loading bitcoin module...');
    const importPromise = import('@/utils/bitcoin');
    const timeoutMs = 10_000;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Bitcoin module import timed out after ${timeoutMs}ms`)), timeoutMs)
    );
    bitcoinModule = await Promise.race([importPromise, timeout]);
    if (__DEV__) console.log('[WalletStore] Bitcoin module loaded');
  }
  return bitcoinModule;
}

const MNEMONIC_KEY = 'meshcore_wallet_mnemonic';
const WALLET_INITIALIZED_KEY = 'meshcore_wallet_initialized';

// ─── Types ───────────────────────────────────────────────────────────────────

interface EncryptedWalletBackup {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
}

// ─── Wallet backup chiffré (import dynamique) ─────────────────────────────────

async function exportWalletEncryptedInternal(mnemonic: string, password: string): Promise<string> {
  // Import dynamique des modules crypto
  const [{ pbkdf2 }, { sha256 }, { bytesToHex, randomBytes }, { gcm }] = await Promise.all([
    import('@noble/hashes/pbkdf2.js').then(m => ({ pbkdf2: m.pbkdf2 })),
    import('@noble/hashes/sha2.js').then(m => ({ sha256: m.sha256 })),
    import('@noble/hashes/utils.js').then(m => ({ bytesToHex: m.bytesToHex, randomBytes: m.randomBytes })),
    import('@noble/ciphers/aes'),
  ]);

  if (!mnemonic || !password) throw new Error('Mnemonic et mot de passe requis');

  const salt = randomBytes(32);
  const iv = randomBytes(12);

  const key = pbkdf2(sha256, new TextEncoder().encode(password), salt, { c: 10_000, dkLen: 32 });
  const plaintext = new TextEncoder().encode(mnemonic);
  const ciphertext = gcm(key, iv).encrypt(plaintext);

  const backup: EncryptedWalletBackup = {
    v: 1,
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ct: bytesToHex(ciphertext),
  };
  return JSON.stringify(backup);
}

async function importWalletDecryptedInternal(backupJson: string, password: string): Promise<string> {
  const [{ pbkdf2 }, { sha256 }, { hexToBytes }, { gcm }] = await Promise.all([
    import('@noble/hashes/pbkdf2.js').then(m => ({ pbkdf2: m.pbkdf2 })),
    import('@noble/hashes/sha2.js').then(m => ({ sha256: m.sha256 })),
    import('@noble/hashes/utils.js').then(m => ({ hexToBytes: m.hexToBytes })),
    import('@noble/ciphers/aes'),
  ]);

  let backup: EncryptedWalletBackup;
  try {
    backup = JSON.parse(backupJson) as EncryptedWalletBackup;
  } catch {
    throw new Error('Format de backup invalide — JSON attendu');
  }

  const salt = hexToBytes(backup.salt);
  const iv = hexToBytes(backup.iv);
  const ciphertext = hexToBytes(backup.ct);

  const key = pbkdf2(sha256, new TextEncoder().encode(password), salt, { c: 10_000, dkLen: 32 });

  try {
    const plaintext = gcm(key, iv).decrypt(ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error('Mot de passe incorrect ou backup corrompu');
  }
}

// ─── Storage Adapter pour Zustand ────────────────────────────────────────────

const secureWalletStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const mnemonic = await SecureStore.getItemAsync(MNEMONIC_KEY);
      const initialized = await SecureStore.getItemAsync(WALLET_INITIALIZED_KEY);
      
      if (!mnemonic) {
        const legacy = await AsyncStorage.getItem(MNEMONIC_KEY);
        if (legacy) {
          const btc = await loadBitcoinModule();
          if (btc && btc.validateMnemonic(legacy)) {
            console.warn('[WalletStore] Migration : mnemonic non chiffré détecté, migration vers SecureStore...');
            await SecureStore.setItemAsync(MNEMONIC_KEY, legacy);
            await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
            const written = await SecureStore.getItemAsync(MNEMONIC_KEY);
            if (written === legacy) {
              await AsyncStorage.removeItem(MNEMONIC_KEY);
              await AsyncStorage.removeItem(WALLET_INITIALIZED_KEY);
              console.log('[WalletStore] Migration réussie');
              return JSON.stringify({
                state: { mnemonic: legacy, isInitialized: true, _hasHydrated: true },
                version: 0,
              });
            }
          }
        }
        return JSON.stringify({
          state: { mnemonic: null, isInitialized: false, _hasHydrated: true },
          version: 0,
        });
      }

      return JSON.stringify({
        state: { mnemonic, isInitialized: initialized === 'true', _hasHydrated: true },
        version: 0,
      });
    } catch (err) {
      console.error('[WalletStore] Error loading from secure storage:', err);
      return JSON.stringify({
        state: { mnemonic: null, isInitialized: false, _hasHydrated: true },
        version: 0,
      });
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

// ─── Store ───────────────────────────────────────────────────────────────────

export interface WalletState {
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
  rehydrationError: Error | null;
  _hasHydrated: boolean;

  generateWallet: (strength?: 12 | 24) => Promise<void>;
  importWallet: (mnemonic: string) => Promise<void>;
  deleteWallet: () => Promise<void>;
  exportWallet: (password: string) => Promise<string>;
  importEncryptedWallet: (backupJson: string, password: string) => Promise<void>;
  getFormattedAddress: () => string;
  setHasHydrated: (hasHydrated: boolean) => void;
  _setWalletData: (mnemonic: string) => Promise<void>;
  _clearWalletData: () => void;
  _setLoading: (loading: boolean) => void;
  _setGenerating: (generating: boolean) => void;
  _setImporting: (importing: boolean) => void;
  _setGenerateError: (error: Error | null) => void;
  _setImportError: (error: Error | null) => void;
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
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
      rehydrationError: null,
      _hasHydrated: false,

      generateWallet: async (strength: 12 | 24 = 12) => {
        console.log('[WalletStore] === generateWallet START ===');
        const startTime = Date.now();
        
        try {
          set({ isGenerating: true, generateError: null });
          console.log('[WalletStore] Loading bitcoin module...');
          
          const btc = await loadBitcoinModule();
          if (!btc) {
            throw new Error('Failed to load bitcoin module');
          }
          
          console.log('[WalletStore] Calling generateMnemonic...');
          const newMnemonic = btc.generateMnemonic(strength);
          console.log('[WalletStore] Mnemonic generated in', Date.now() - startTime, 'ms');
          
          await SecureStore.setItemAsync(MNEMONIC_KEY, newMnemonic);
          await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
          console.log('[WalletStore] Saved to SecureStore');
          
          const walletInfo = btc.deriveWalletInfo(newMnemonic);
          // Derive only 5 addresses initially to avoid freeze (rest can be derived lazily)
          const receiveAddresses = btc.deriveReceiveAddresses(newMnemonic, 5);
          await new Promise<void>(r => setTimeout(r, 0)); // yield thread
          const changeAddresses = btc.deriveChangeAddresses(newMnemonic, 5);
          
          set({
            mnemonic: newMnemonic,
            walletInfo,
            receiveAddresses,
            changeAddresses,
            isInitialized: true,
            isGenerating: false,
            generateError: null,
          });
          
          console.log('[WalletStore] === generateWallet SUCCESS ===');
          
          // NOTE: L'événement Hermès WALLET_INITIALIZED est émis par UnifiedIdentityManager
          // pour éviter la double émission. Voir engine/identity/UnifiedIdentityManager.ts
        } catch (error: any) {
          console.error('[WalletStore] === generateWallet ERROR ===', error?.message || error);
          set({ 
            generateError: error instanceof Error ? error : new Error(String(error)),
            isGenerating: false 
          });
        }
      },

      importWallet: async (importedMnemonic: string) => {
        console.log('[WalletStore] Importing wallet...');
        set({ isImporting: true, importError: null });

        try {
          const btc = await loadBitcoinModule();
          if (!btc) throw new Error('Failed to load bitcoin module');

          const trimmed = importedMnemonic.trim().toLowerCase();
          if (!btc.validateMnemonic(trimmed)) {
            throw new Error('Phrase mnémonique invalide (vérifiez les mots et l\'ordre)');
          }

          const wordCount = trimmed.split(/\s+/).length;
          if (wordCount !== 12 && wordCount !== 24) {
            throw new Error(`Longueur invalide : ${wordCount} mots (12 ou 24 requis)`);
          }
          
          await SecureStore.setItemAsync(MNEMONIC_KEY, trimmed);
          await SecureStore.setItemAsync(WALLET_INITIALIZED_KEY, 'true');
          
          const walletInfo = btc.deriveWalletInfo(trimmed);
          const receiveAddresses = btc.deriveReceiveAddresses(trimmed, 5);
          await new Promise<void>(r => setTimeout(r, 0)); // yield thread
          const changeAddresses = btc.deriveChangeAddresses(trimmed, 5);
          
          set({
            mnemonic: trimmed,
            walletInfo,
            receiveAddresses,
            changeAddresses,
            isInitialized: true,
            isImporting: false,
            importError: null,
          });
          
          console.log('[WalletStore] Wallet imported successfully');
          
          // NOTE: L'événement Hermès WALLET_INITIALIZED est émis par UnifiedIdentityManager
        } catch (error: any) {
          console.error('[WalletStore] Import error:', error);
          set({ 
            importError: error instanceof Error ? error : new Error(String(error)),
            isImporting: false 
          });
        }
      },

      deleteWallet: async () => {
        console.log('[WalletStore] Deleting wallet...');
        try {
          await SecureStore.deleteItemAsync(MNEMONIC_KEY);
          await SecureStore.deleteItemAsync(WALLET_INITIALIZED_KEY);
          await AsyncStorage.removeItem(MNEMONIC_KEY);
          await AsyncStorage.removeItem(WALLET_INITIALIZED_KEY);

          // Vider le cache de seeds dérivées pour ne pas garder l'ancien
          // mnemonic → seed en mémoire après suppression.
          const btc = await loadBitcoinModule();
          btc?.clearSeedCache?.();
          
          set({
            mnemonic: null,
            walletInfo: null,
            receiveAddresses: [],
            changeAddresses: [],
            isInitialized: false,
          });
          
          // Émettre événement Hermès WALLET_DELETED
          try {
            await hermes.createEvent(
              EventType.WALLET_DELETED,
              {
                timestamp: Date.now(),
              },
              {
                from: 'wallet_store',
                transport: Transport.INTERNAL,
              }
            );
            console.log('[WalletStore] Hermès event WALLET_DELETED emitted');
          } catch (hermesError) {
            console.error('[WalletStore] Failed to emit Hermès event:', hermesError);
          }
          
          console.log('[WalletStore] Wallet deleted');
        } catch (error) {
          console.error('[WalletStore] Delete error:', error);
          throw error;
        }
      },

      exportWallet: async (password: string): Promise<string> => {
        const { mnemonic } = get();
        if (!mnemonic) throw new Error('Aucun wallet à exporter');
        return await exportWalletEncryptedInternal(mnemonic, password);
      },

      importEncryptedWallet: async (backupJson: string, password: string) => {
        const decrypted = await importWalletDecryptedInternal(backupJson, password);
        await get().importWallet(decrypted);
      },

      getFormattedAddress: () => {
        const { walletInfo } = get();
        if (walletInfo?.firstReceiveAddress) {
          const addr = walletInfo.firstReceiveAddress;
          return addr.slice(0, 6) + '...' + addr.slice(-4);
        }
        return 'No wallet';
      },

      setHasHydrated: (hasHydrated: boolean) => {
        set({ _hasHydrated: hasHydrated, isLoading: false });
      },

      _setWalletData: async (mnemonic: string) => {
        try {
          const btc = await loadBitcoinModule();
          if (!btc) return;
          const walletInfo = btc.deriveWalletInfo(mnemonic);
          await new Promise<void>(r => setTimeout(r, 0)); // yield thread
          const receiveAddresses = btc.deriveReceiveAddresses(mnemonic, 5);
          await new Promise<void>(r => setTimeout(r, 0)); // yield thread
          const changeAddresses = btc.deriveChangeAddresses(mnemonic, 5);
          set({
            mnemonic,
            walletInfo,
            receiveAddresses,
            changeAddresses,
            isInitialized: true,
          });
        } catch (err) {
          console.error('[WalletStore] _setWalletData error:', err);
        }
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
        if (__DEV__) console.log('[WalletStore] Rehydrated from storage', { hasState: !!state, error });
        if (error) {
          // Le storage lui-même a échoué — SecureStore corrompu ou indispo
          const err = error instanceof Error ? error : new Error(String(error));
          useWalletStore.setState({ rehydrationError: err });
          useWalletStore.getState().setHasHydrated(true);
          return;
        }
        if (state) {
          if (state.mnemonic) {
            state._setWalletData(state.mnemonic).then(() => {
              state.setHasHydrated(true);
            }).catch((e) => {
              console.warn('[WalletStore] Rehydration _setWalletData failed:', e);
              const err = e instanceof Error ? e : new Error(String(e));
              useWalletStore.setState({ rehydrationError: err });
              state.setHasHydrated(true);
            });
          } else {
            state.setHasHydrated(true);
          }
        }
      },
      partialize: (state) => ({
        _hasHydrated: state._hasHydrated,
      }),
    }
  )
);

// ─── Ré-exports pour compatibilité ────────────────────────────────────────────

export function exportWalletEncrypted(mnemonic: string, password: string): Promise<string> {
  return exportWalletEncryptedInternal(mnemonic, password);
}

export function importWalletDecrypted(backupJson: string, password: string): Promise<string> {
  return importWalletDecryptedInternal(backupJson, password);
}

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

export function useWalletAddresses() {
  return useWalletStore((state) => ({
    receiveAddresses: state.receiveAddresses,
    changeAddresses: state.changeAddresses,
  }));
}
