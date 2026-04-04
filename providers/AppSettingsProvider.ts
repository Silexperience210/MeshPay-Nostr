/**
 * AppSettingsProvider — Couche de compatibilité vers Zustand
 *
 * Ce fichier conserve la même interface publique qu'avant
 * (AppSettingsContext, useAppSettings, AppSettings, etc.) mais délègue
 * toute la logique au settingsStore Zustand.
 *
 * Cela permet à tous les composants existants (tabs, providers) de continuer
 * à importer { useAppSettings } sans modification.
 */

import createContextHook from '@nkzw/create-context-hook';
import { useSettingsStore } from '@/stores/settingsStore';

// ─── Ré-exports des types depuis settingsStore ────────────────────────────────

export type {
  ConnectionMode,
  AppLanguage,
  NostrRelayConfig,
  AppSettings,
} from '@/stores/settingsStore';

// ─── Interface publique du hook (inchangée) ───────────────────────────────────

export interface AppSettingsHookValue {
  settings: import('@/stores/settingsStore').AppSettings;
  updateSettings: (partial: Partial<import('@/stores/settingsStore').AppSettings>) => void;
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

// ─── Thin wrapper → Zustand settingsStore ────────────────────────────────────

export const [AppSettingsContext, useAppSettings] = createContextHook((): AppSettingsHookValue => {
  const store = useSettingsStore();

  // Reconstruire l'objet settings depuis les champs plats du store
  const settings: import('@/stores/settingsStore').AppSettings = {
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
  };

  return {
    settings,
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
});
