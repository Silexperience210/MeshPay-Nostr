/**
 * Outils de migration - Helpers pour la transition Providers → Zustand
 * 
 * Ce fichier fournit des utilitaires pour faciliter la migration progressive
 * de l'app depuis les Context Providers vers Zustand.
 */

import { useEffect } from 'react';
import { useWalletStore } from './walletStore';
import { useSettingsStore } from './settingsStore';

// ─── Types pour la migration ─────────────────────────────────────────────────

export interface LegacyWalletData {
  mnemonic: string | null;
  isInitialized: boolean;
}

export interface LegacySettingsData {
  connectionMode: 'internet' | 'lora' | 'bridge';
  language: 'en' | 'fr' | 'es';
  [key: string]: any;
}

// ─── Hook de synchronisation bidirectionnelle ────────────────────────────────

/**
 * Hook qui synchronise les anciens providers avec les nouveaux stores
 * pendant la période de transition.
 * 
 * Usage: À ajouter dans le composant racine pendant la migration
 */
export function useMigrationSync(
  legacyWallet?: LegacyWalletData,
  legacySettings?: LegacySettingsData
) {
  const walletStore = useWalletStore();
  const settingsStore = useSettingsStore();

  // Sync legacy → Zustand (une seule fois au montage)
  useEffect(() => {
    // Si le store Zustand est vide mais qu'on a des données legacy
    if (!walletStore.isInitialized && legacyWallet?.isInitialized) {
      console.log('[Migration] Syncing wallet from legacy to Zustand');
      // La persistence s'occupera du stockage, on ne fait que setter l'état
      if (legacyWallet.mnemonic) {
        walletStore._setWalletData(legacyWallet.mnemonic);
      }
    }

    // Sync settings
    if (!settingsStore._hasHydrated && legacySettings) {
      console.log('[Migration] Syncing settings from legacy to Zustand');
      settingsStore.updateSettings(legacySettings);
    }
  }, []);

  return {
    isMigrated: walletStore._hasHydrated && settingsStore._hasHydrated,
    walletStore,
    settingsStore,
  };
}

// ─── Utilitaire de vérification ──────────────────────────────────────────────

/**
 * Vérifie si les stores Zustand sont prêts à remplacer les providers
 */
export function checkMigrationStatus(): {
  walletReady: boolean;
  settingsReady: boolean;
  ready: boolean;
} {
  const walletState = useWalletStore.getState();
  const settingsState = useSettingsStore.getState();

  const walletReady = walletState._hasHydrated;
  const settingsReady = settingsState._hasHydrated;

  return {
    walletReady,
    settingsReady,
    ready: walletReady && settingsReady,
  };
}

// ─── Fonction de migration forcée ────────────────────────────────────────────

/**
 * Force la migration des données depuis AsyncStorage vers les stores
 * Utile pour la première initialisation
 */
export async function forceMigration(): Promise<{
  success: boolean;
  walletMigrated: boolean;
  settingsMigrated: boolean;
  error?: string;
}> {
  try {
    // Les stores sont déjà initialisés avec persist middleware
    // On vérifie juste qu'ils sont bien hydratés
    const status = checkMigrationStatus();

    if (!status.ready) {
      // Attendre l'hydratation
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const newStatus = checkMigrationStatus();
      
      return {
        success: newStatus.ready,
        walletMigrated: newStatus.walletReady,
        settingsMigrated: newStatus.settingsReady,
      };
    }

    return {
      success: true,
      walletMigrated: true,
      settingsMigrated: true,
    };
  } catch (err) {
    return {
      success: false,
      walletMigrated: false,
      settingsMigrated: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

// ─── Reset pour tests ────────────────────────────────────────────────────────

/**
 * Reset tous les stores (pour tests uniquement)
 */
export function resetAllStores(): void {
  useWalletStore.setState({
    mnemonic: null,
    walletInfo: null,
    receiveAddresses: [],
    changeAddresses: [],
    isInitialized: false,
    isLoading: false,
    isGenerating: false,
    isImporting: false,
    generateError: null,
    importError: null,
    _hasHydrated: true,
  });

  useSettingsStore.setState({
    connectionMode: 'internet',
    language: 'en',
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
    nostrRelays: [
      { url: 'wss://relay.damus.io', enabled: true },
      { url: 'wss://nos.lol', enabled: true },
      { url: 'wss://relay.nostr.band', enabled: true },
      { url: 'wss://nostr.wine', enabled: true },
      { url: 'wss://relay.snort.social', enabled: true },
    ],
    isLoading: false,
    isSaving: false,
    _hasHydrated: true,
  });

  console.log('[Migration] All stores reset');
}
