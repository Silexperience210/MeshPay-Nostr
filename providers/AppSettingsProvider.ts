import { useState, useEffect, useCallback } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import createContextHook from '@nkzw/create-context-hook';
import { setTrustedMints } from '@/utils/cashu';

const SETTINGS_KEY = 'meshcore_app_settings';

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
  defaultCashuMint: 'https://mint.minibits.cash/Bitcoin', // ✅ MAINNET - minibits.cash
  fallbackCashuMint: 'https://mint.lnvoltz.com', // ✅ BACKUP TESTÉ ET FONCTIONNEL
  customCashuMint: '',
  useCustomCashuMint: false,
  bitcoinNetwork: 'mainnet',
  fiatCurrency: 'EUR',
  autoSyncInterval: 30000,
  autoRelay: true,
  notifications: true,
  shareLocation: false,
  nostrRelays: [
    { url: 'wss://relay.damus.io', enabled: true },
    { url: 'wss://nos.lol', enabled: true },
    { url: 'wss://relay.nostr.band', enabled: true },
    { url: 'wss://nostr.wine', enabled: true },
    { url: 'wss://relay.snort.social', enabled: true },
  ],
};

export const [AppSettingsContext, useAppSettings] = createContextHook(() => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  const loadQuery = useQuery({
    queryKey: ['app-settings'],
    queryFn: async () => {
      console.log('[AppSettings] Loading settings...');
      try {
        const stored = await AsyncStorage.getItem(SETTINGS_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as Partial<AppSettings>;
          console.log('[AppSettings] Loaded stored settings');
          return { ...DEFAULT_SETTINGS, ...parsed };
        }
        console.log('[AppSettings] No stored settings, using defaults');
        return DEFAULT_SETTINGS;
      } catch (err) {
        console.log('[AppSettings] Error loading settings:', err);
        return DEFAULT_SETTINGS;
      }
    },
    staleTime: Infinity,
  });

  useEffect(() => {
    if (loadQuery.data) {
      setSettings(loadQuery.data);
      // Synchroniser la whitelist Cashu dès le chargement des settings
      const mints = [
        loadQuery.data.defaultCashuMint,
        loadQuery.data.fallbackCashuMint,
        loadQuery.data.customCashuMint,
      ].filter(Boolean);
      setTrustedMints(mints);
    }
  }, [loadQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async (newSettings: AppSettings) => {
      console.log('[AppSettings] Saving settings...');
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(newSettings));
      return newSettings;
    },
    onSuccess: (saved) => {
      setSettings(saved);
      console.log('[AppSettings] Settings saved successfully');
    },
    onError: (err) => {
      console.log('[AppSettings] Error saving settings:', err);
    },
  });

  const updateSettings = useCallback((partial: Partial<AppSettings>) => {
    const updated = { ...settings, ...partial };
    setSettings(updated);
    saveMutation.mutate(updated);
    // Re-synchroniser la whitelist Cashu si les mints ont changé
    if (partial.defaultCashuMint || partial.fallbackCashuMint || partial.customCashuMint) {
      const mints = [updated.defaultCashuMint, updated.fallbackCashuMint, updated.customCashuMint].filter(Boolean);
      setTrustedMints(mints);
    }
  }, [settings, saveMutation]);

  const getMempoolUrl = useCallback((): string => {
    if (settings.useCustomMempool && settings.customMempoolUrl.trim()) {
      return settings.customMempoolUrl.trim().replace(/\/$/, '');
    }
    return settings.mempoolUrl;
  }, [settings]);

  /** Retourne les URLs des relays Nostr activés (au moins 1 garanti) */
  const getActiveRelayUrls = useCallback((): string[] => {
    const active = settings.nostrRelays.filter(r => r.enabled).map(r => r.url);
    if (active.length === 0) {
      // Fallback de sécurité : si tout est désactivé on garde le premier relay
      return [settings.nostrRelays[0]?.url ?? 'wss://relay.damus.io'];
    }
    return active;
  }, [settings.nostrRelays]);

  const getCashuMintUrl = useCallback((): string => {
    if (settings.useCustomCashuMint && settings.customCashuMint.trim()) {
      return settings.customCashuMint.trim().replace(/\/$/, '');
    }
    return settings.defaultCashuMint;
  }, [settings]);

  const resetToDefaults = useCallback(() => {
    saveMutation.mutate(DEFAULT_SETTINGS);
  }, [saveMutation]);

  const isInternetMode = settings.connectionMode === 'internet' || settings.connectionMode === 'bridge';
  const isLoRaMode = settings.connectionMode === 'lora' || settings.connectionMode === 'bridge';
  const isBridgeMode = settings.connectionMode === 'bridge';

  return {
    settings,
    updateSettings,
    getMempoolUrl,
    getCashuMintUrl,
    getActiveRelayUrls,
    resetToDefaults,
    isInternetMode,
    isLoRaMode,
    isBridgeMode,
    isLoading: loadQuery.isLoading,
    isSaving: saveMutation.isPending,
  };
});
