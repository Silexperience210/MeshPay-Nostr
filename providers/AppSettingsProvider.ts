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
import { useMemo } from 'react';
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
  // Sélecteurs granulaires pour éviter la souscription complète au store
  const connectionMode = useSettingsStore(s => s.connectionMode);
  const language = useSettingsStore(s => s.language);
  const onboardingLangDone = useSettingsStore(s => s.onboardingLangDone);
  const mempoolUrl = useSettingsStore(s => s.mempoolUrl);
  const customMempoolUrl = useSettingsStore(s => s.customMempoolUrl);
  const useCustomMempool = useSettingsStore(s => s.useCustomMempool);
  const defaultCashuMint = useSettingsStore(s => s.defaultCashuMint);
  const fallbackCashuMint = useSettingsStore(s => s.fallbackCashuMint);
  const customCashuMint = useSettingsStore(s => s.customCashuMint);
  const useCustomCashuMint = useSettingsStore(s => s.useCustomCashuMint);
  const bitcoinNetwork = useSettingsStore(s => s.bitcoinNetwork);
  const fiatCurrency = useSettingsStore(s => s.fiatCurrency);
  const autoSyncInterval = useSettingsStore(s => s.autoSyncInterval);
  const autoRelay = useSettingsStore(s => s.autoRelay);
  const loraAutoConnect = useSettingsStore(s => s.loraAutoConnect);
  const preferredRelaySet = useSettingsStore(s => s.preferredRelaySet);
  const customRelays = useSettingsStore(s => s.customRelays);
  const gatewayMode = useSettingsStore(s => s.gatewayMode);
  const gatewayServices = useSettingsStore(s => s.gatewayServices);
  const _updateSettings = useSettingsStore(s => s.updateSettings);
  const _resetToDefaults = useSettingsStore(s => s.resetToDefaults);
  const _isLoading = useSettingsStore(s => s.isLoading);
  const _isSaving = useSettingsStore(s => s.isSaving);
  const _mempoolUrlResolved = useSettingsStore(s => s.mempoolUrlResolved);
  const _cashuMintUrlResolved = useSettingsStore(s => s.cashuMintUrlResolved);
  const _activeRelayUrls = useSettingsStore(s => s.activeRelayUrls);
  const notifications = useSettingsStore(s => s.notifications);
  const shareLocation = useSettingsStore(s => s.shareLocation);
  const nostrRelays = useSettingsStore(s => s.nostrRelays);
  const isInternetMode = useSettingsStore(s => s.connectionMode === 'internet');
  const isLoRaMode = useSettingsStore(s => s.connectionMode === 'lora');
  const isBridgeMode = useSettingsStore(s => s.connectionMode === 'bridge');

  const settings: import('@/stores/settingsStore').AppSettings = useMemo(() => ({
    connectionMode: connectionMode,
    language: language,
    onboardingLangDone: onboardingLangDone,
    mempoolUrl: mempoolUrl,
    customMempoolUrl: customMempoolUrl,
    useCustomMempool: useCustomMempool,
    defaultCashuMint: defaultCashuMint,
    fallbackCashuMint: fallbackCashuMint,
    customCashuMint: customCashuMint,
    useCustomCashuMint: useCustomCashuMint,
    bitcoinNetwork: bitcoinNetwork,
    fiatCurrency: fiatCurrency,
    autoSyncInterval: autoSyncInterval,
    autoRelay: autoRelay,
    notifications: notifications,
    shareLocation: shareLocation,
    nostrRelays: nostrRelays,
  }), [
    connectionMode,
    language,
    onboardingLangDone,
    mempoolUrl,
    customMempoolUrl,
    useCustomMempool,
    defaultCashuMint,
    fallbackCashuMint,
    customCashuMint,
    useCustomCashuMint,
    bitcoinNetwork,
    fiatCurrency,
    autoSyncInterval,
    autoRelay,
    notifications,
    shareLocation,
    nostrRelays,
  ]);

  return useMemo(() => ({
    settings,
    updateSettings: _updateSettings,
    getMempoolUrl: () => _mempoolUrlResolved,
    getCashuMintUrl: () => _cashuMintUrlResolved,
    getActiveRelayUrls: () => _activeRelayUrls,
    resetToDefaults: _resetToDefaults,
    isInternetMode: isInternetMode,
    isLoRaMode: isLoRaMode,
    isBridgeMode: isBridgeMode,
    isLoading: _isLoading,
    isSaving: _isSaving,
  }), [
    settings,
    _updateSettings,
    _mempoolUrlResolved,
    _cashuMintUrlResolved,
    _activeRelayUrls,
    _resetToDefaults,
    isInternetMode,
    isLoRaMode,
    isBridgeMode,
    _isLoading,
    _isSaving,
  ]);
});
