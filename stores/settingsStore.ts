/**
 * Settings Store - Remplace AppSettingsProvider
 * Gère les paramètres de l'application avec persistance dans AsyncStorage
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setTrustedMints } from '@/utils/cashu';
import { setLanguage as setI18nLanguage } from '@/locales';

const SETTINGS_KEY = 'meshcore_app_settings_v2';

export type ConnectionMode = 'internet' | 'lora' | 'bridge';
export type AppLanguage = 'en' | 'fr' | 'es';

export interface NostrRelayConfig {
  url: string;
  enabled: boolean;
  /** true = ajouté par l'utilisateur (peut être supprimé) */
  custom?: boolean;
}

export interface AppSettings {
  connectionMode: ConnectionMode;
  language: AppLanguage;
  onboardingLangDone: boolean;
  mempoolUrl: string;
  customMempoolUrl: string;
  useCustomMempool: boolean;
  defaultCashuMint: string;
  fallbackCashuMint: string;
  customCashuMint: string;
  useCustomCashuMint: boolean;
  bitcoinNetwork: 'mainnet' | 'testnet';
  fiatCurrency: string;
  autoSyncInterval: number;
  autoRelay: boolean;
  notifications: boolean;
  shareLocation: boolean;
  /** Relays Nostr — liste ordonnée avec état activé/désactivé */
  nostrRelays: NostrRelayConfig[];
}

function detectLanguage(): AppLanguage {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
    if (locale.startsWith('fr')) return 'fr';
    if (locale.startsWith('es')) return 'es';
  } catch {}
  return 'en';
}

const DEFAULT_SETTINGS: AppSettings = {
  connectionMode: 'internet',
  language: detectLanguage(),
  onboardingLangDone: false,
  mempoolUrl: 'https://mempool.space',
  customMempoolUrl: '',
  useCustomMempool: false,
  defaultCashuMint: 'https://mint.minibits.cash/Bitcoin',
  fallbackCashuMint: 'https://mint.lnvoltz.com',
  customCashuMint: '',
  useCustomCashuMint: false,
  bitcoinNetwork: 'mainnet',
  fiatCurrency: 'EUR',
  autoSyncInterval: 30000,
  autoRelay: true,
  notifications: true,
  shareLocation: false,
  // ✅ FIX FORUM DISCOVERY (v1.0.15) : relais validés en production.
  // Voir aussi DEFAULT_RELAYS dans utils/nostr-client.ts (doivent rester sync).
  // Migration auto via ensureRelayDefaults() si l'utilisateur a une liste obsolète.
  nostrRelays: [
    { url: 'wss://relay.damus.io', enabled: true },        // ✅ Très fiable
    { url: 'wss://relay.primal.net', enabled: true },      // ✅ Très fiable (ajouté v1.0.15)
    { url: 'wss://nos.lol', enabled: true },
    { url: 'wss://nostr.bitcoiner.social', enabled: true },
    { url: 'wss://relay.snort.social', enabled: false },   // Désactivé : trop souvent timeout
  ],
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SettingsState extends AppSettings {
  // Loading states
  isLoading: boolean;
  isSaving: boolean;
  _hasHydrated: boolean;

  // Actions
  updateSettings: (partial: Partial<AppSettings>) => void;
  setConnectionMode: (mode: ConnectionMode) => void;
  setLanguage: (lang: AppLanguage) => void;
  toggleGateway: () => void;
  toggleNotifications: () => void;
  toggleLocation: () => void;
  toggleAutoRelay: () => void;
  toggleRelay: (url: string) => void;
  addCustomRelay: (url: string) => void;
  removeCustomRelay: (url: string) => void;
  updateRelayOrder: (relays: NostrRelayConfig[]) => void;
  setMempoolUrl: (url: string, isCustom?: boolean) => void;
  setCashuMint: (url: string, isCustom?: boolean) => void;
  updateServices: (services: Partial<Pick<AppSettings, 'mempoolUrl' | 'defaultCashuMint'>>) => void;
  resetToDefaults: () => void;
  setHasHydrated: (hasHydrated: boolean) => void;

  // Getters
  getMempoolUrl: () => string;
  getCashuMintUrl: () => string;
  getActiveRelayUrls: () => string[];
  isInternetMode: () => boolean;
  isLoRaMode: () => boolean;
  isBridgeMode: () => boolean;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      // Initial state from defaults
      ...DEFAULT_SETTINGS,
      isLoading: true,
      isSaving: false,
      _hasHydrated: false,

      // Actions
      updateSettings: (partial: Partial<AppSettings>) => {
        set((state) => ({ ...state, ...partial }));

        // Re-synchroniser la whitelist Cashu si les mints ont changé
        if (partial.defaultCashuMint || partial.fallbackCashuMint || partial.customCashuMint) {
          try {
            const updated = get();
            const mints = [
              updated.defaultCashuMint,
              updated.fallbackCashuMint,
              updated.customCashuMint,
            ].filter(Boolean) as string[];
            setTrustedMints(mints);
          } catch (e) {
            console.warn('[SettingsStore] setTrustedMints failed:', e);
          }
        }

        console.log('[SettingsStore] Settings updated');
      },

      setConnectionMode: (mode: ConnectionMode) => {
        get().updateSettings({ connectionMode: mode });
        console.log('[SettingsStore] Connection mode set to:', mode);
      },

      setLanguage: (lang: AppLanguage) => {
        get().updateSettings({ language: lang });
        // Synchroniser le système i18n avec la langue du store
        setI18nLanguage(lang);
        console.log('[SettingsStore] Language set to:', lang);
      },

      toggleGateway: () => {
        // Bascule entre internet et bridge
        const current = get().connectionMode;
        const newMode = current === 'internet' ? 'bridge' : 'internet';
        get().setConnectionMode(newMode);
      },

      toggleNotifications: () => {
        get().updateSettings({ notifications: !get().notifications });
      },

      toggleLocation: () => {
        get().updateSettings({ shareLocation: !get().shareLocation });
      },

      toggleAutoRelay: () => {
        get().updateSettings({ autoRelay: !get().autoRelay });
      },

      toggleRelay: (url: string) => {
        const relays = get().nostrRelays.map(r =>
          r.url === url ? { ...r, enabled: !r.enabled } : r
        );
        get().updateSettings({ nostrRelays: relays });
      },

      addCustomRelay: (url: string) => {
        const trimmed = url.trim();
        // Sécurité : seuls wss:// (TLS) sont acceptés. ws:// exposerait les messages
        // en clair sur le réseau — inacceptable pour un client Nostr chiffré.
        if (!/^wss:\/\/[^\s]+$/i.test(trimmed)) {
          throw new Error('URL relay invalide : seul wss:// est accepté');
        }
        const existing = get().nostrRelays.find(r => r.url === trimmed);
        if (existing) return;

        const relays = [...get().nostrRelays, { url: trimmed, enabled: true, custom: true }];
        get().updateSettings({ nostrRelays: relays });
      },

      removeCustomRelay: (url: string) => {
        const relays = get().nostrRelays.filter(r => r.url !== url || !r.custom);
        get().updateSettings({ nostrRelays: relays });
      },

      updateRelayOrder: (relays: NostrRelayConfig[]) => {
        get().updateSettings({ nostrRelays: relays });
      },

      setMempoolUrl: (url: string, isCustom: boolean = false) => {
        if (isCustom) {
          get().updateSettings({ customMempoolUrl: url, useCustomMempool: true });
        } else {
          get().updateSettings({ mempoolUrl: url, useCustomMempool: false });
        }
      },

      setCashuMint: (url: string, isCustom: boolean = false) => {
        if (isCustom) {
          get().updateSettings({ customCashuMint: url, useCustomCashuMint: true });
        } else {
          get().updateSettings({ defaultCashuMint: url, useCustomCashuMint: false });
        }
      },

      updateServices: (services: Partial<Pick<AppSettings, 'mempoolUrl' | 'defaultCashuMint'>>) => {
        get().updateSettings(services);
      },

      resetToDefaults: () => {
        set({ ...DEFAULT_SETTINGS, isLoading: false, isSaving: false, _hasHydrated: true });
        setTrustedMints([DEFAULT_SETTINGS.defaultCashuMint, DEFAULT_SETTINGS.fallbackCashuMint]);
        console.log('[SettingsStore] Settings reset to defaults');
      },

      setHasHydrated: (hasHydrated: boolean) => {
        set({ _hasHydrated: hasHydrated, isLoading: false });
      },

      // Getters
      getMempoolUrl: () => {
        const state = get();
        if (state.useCustomMempool && state.customMempoolUrl.trim()) {
          return state.customMempoolUrl.trim().replace(/\/$/, '');
        }
        return state.mempoolUrl;
      },

      getCashuMintUrl: () => {
        const state = get();
        if (state.useCustomCashuMint && state.customCashuMint.trim()) {
          return state.customCashuMint.trim().replace(/\/$/, '');
        }
        return state.defaultCashuMint;
      },

      getActiveRelayUrls: () => {
        const active = get().nostrRelays.filter(r => r.enabled).map(r => r.url);
        if (active.length === 0) {
          // Fallback de sécurité : si tout est désactivé on garde le premier relay
          return [get().nostrRelays[0]?.url ?? 'wss://relay.damus.io'];
        }
        return active;
      },

      isInternetMode: () => {
        const mode = get().connectionMode;
        return mode === 'internet' || mode === 'bridge';
      },

      isLoRaMode: () => {
        const mode = get().connectionMode;
        return mode === 'lora' || mode === 'bridge';
      },

      isBridgeMode: () => {
        return get().connectionMode === 'bridge';
      },
    }),
    {
      name: SETTINGS_KEY,
      storage: createJSONStorage(() => AsyncStorage),
      onRehydrateStorage: () => (state, error) => {
        console.log('[SettingsStore] Rehydrated from storage', { hasState: !!state, error });
        // FIX: Toujours marquer comme hydraté pour éviter le freeze sur le splash screen
        if (state) {
          state.setHasHydrated(true);
          // Synchroniser la whitelist Cashu dès le chargement
          const mints = [
            state.defaultCashuMint,
            state.fallbackCashuMint,
            state.customCashuMint,
          ].filter(Boolean) as string[];
          setTrustedMints(mints);

          // ✅ MIGRATION RELAIS (v1.0.15+) : forcer l'ajout des relais
          // fiables pour les utilisateurs existants. Sans cette migration,
          // les users avec une vieille liste persistée n'utiliseraient pas
          // relay.primal.net → forum discovery cassée.
          const RELIABLE_RELAYS = [
            'wss://relay.damus.io',
            'wss://relay.primal.net',
            'wss://nos.lol',
            'wss://nostr.bitcoiner.social',
          ];
          // ✅ Relais notoirement défaillants : on les laisse dans la liste pour
          // que l'utilisateur puisse les ré-activer manuellement, mais on les
          // désactive par défaut pour ne pas polluer le statut "error".
          const UNRELIABLE_RELAYS = [
            'wss://relay.nostr.band',     // n'indexe pas kind:40 + souvent timeout
            'wss://nostr.wine',           // n'indexe pas kind:40
            'wss://relay.snort.social',   // souvent timeout
          ];
          const existingUrls = new Set(state.nostrRelays.map(r => r.url));
          let migrated = false;
          for (const url of RELIABLE_RELAYS) {
            if (!existingUrls.has(url)) {
              state.nostrRelays.push({ url, enabled: true });
              console.log(`[SettingsStore] 🔄 Migration : ajout relai ${url}`);
              migrated = true;
            }
          }
          // Désactiver les relais notoirement défaillants
          for (const relay of state.nostrRelays) {
            if (UNRELIABLE_RELAYS.includes(relay.url) && relay.enabled) {
              relay.enabled = false;
              console.log(`[SettingsStore] 🔄 Migration : désactivation relai défaillant ${relay.url}`);
              migrated = true;
            }
          }
          if (migrated) {
            console.log(`[SettingsStore] ✅ Migration relais terminée — ${state.nostrRelays.length} relais configurés (${state.nostrRelays.filter(r => r.enabled).length} actifs)`);
          }
        }
      },
      // Exclure les états de loading de la persistance
      partialize: (state) => ({
        connectionMode: state.connectionMode,
        language: state.language,
        onboardingLangDone: state.onboardingLangDone,
        mempoolUrl: state.mempoolUrl,
        customMempoolUrl: state.customMempoolUrl,
        useCustomMempool: state.useCustomMempool,
        defaultCashuMint: state.defaultCashuMint,
        fallbackCashuMint: state.fallbackCashuMint,
        customCashuMint: state.customCashuMint,
        useCustomCashuMint: state.useCustomCashuMint,
        bitcoinNetwork: state.bitcoinNetwork,
        fiatCurrency: state.fiatCurrency,
        autoSyncInterval: state.autoSyncInterval,
        autoRelay: state.autoRelay,
        notifications: state.notifications,
        shareLocation: state.shareLocation,
        nostrRelays: state.nostrRelays,
      }),
    }
  )
);

// ─── Hooks utilitaires ───────────────────────────────────────────────────────

export function useSettings() {
  return useSettingsStore((state) => ({
    connectionMode: state.connectionMode,
    language: state.language,
    onboardingLangDone: state.onboardingLangDone,
    mempoolUrl: state.mempoolUrl,
    customMempoolUrl: state.customMempoolUrl,
    useCustomMempool: state.useCustomMempool,
    defaultCashuMint: state.defaultCashuMint,
    fallbackCashuMint: state.fallbackCashuMint,
    customCashuMint: state.customCashuMint,
    useCustomCashuMint: state.useCustomCashuMint,
    bitcoinNetwork: state.bitcoinNetwork,
    fiatCurrency: state.fiatCurrency,
    autoSyncInterval: state.autoSyncInterval,
    autoRelay: state.autoRelay,
    notifications: state.notifications,
    shareLocation: state.shareLocation,
    nostrRelays: state.nostrRelays,
  }));
}

export function useSettingsActions() {
  const store = useSettingsStore();
  return {
    updateSettings: store.updateSettings,
    setConnectionMode: store.setConnectionMode,
    setLanguage: store.setLanguage,
    toggleGateway: store.toggleGateway,
    toggleNotifications: store.toggleNotifications,
    toggleLocation: store.toggleLocation,
    toggleAutoRelay: store.toggleAutoRelay,
    toggleRelay: store.toggleRelay,
    addCustomRelay: store.addCustomRelay,
    removeCustomRelay: store.removeCustomRelay,
    updateRelayOrder: store.updateRelayOrder,
    setMempoolUrl: store.setMempoolUrl,
    setCashuMint: store.setCashuMint,
    updateServices: store.updateServices,
    resetToDefaults: store.resetToDefaults,
  };
}

export function useSettingsSelectors() {
  const store = useSettingsStore();
  return {
    getMempoolUrl: store.getMempoolUrl,
    getCashuMintUrl: store.getCashuMintUrl,
    getActiveRelayUrls: store.getActiveRelayUrls,
    isInternetMode: store.isInternetMode,
    isLoRaMode: store.isLoRaMode,
    isBridgeMode: store.isBridgeMode,
  };
}

export function useSettingsLoading() {
  return useSettingsStore((state) => ({
    isLoading: state.isLoading,
    isSaving: state.isSaving,
    isHydrated: state._hasHydrated,
  }));
}

export function useConnectionMode() {
  return useSettingsStore((state) => state.connectionMode);
}

export function useLanguage() {
  return useSettingsStore((state) => state.language);
}
