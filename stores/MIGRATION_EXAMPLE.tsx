/**
 * EXEMPLE DE MIGRATION - Comment remplacer les anciens providers par Zustand
 * 
 * Ce fichier montre un exemple de migration d'un composant utilisant les anciens
 * providers vers les nouveaux stores Zustand.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// AVANT (avec anciens providers)
// ═══════════════════════════════════════════════════════════════════════════════

/*
import { useWalletSeed } from '@/providers/WalletSeedProvider';
import { useAppSettings } from '@/providers/AppSettingsProvider';
import { useBitcoin } from '@/providers/BitcoinProvider';

function WalletScreenOld() {
  // Wallet context - causes re-renders on any wallet change
  const { 
    mnemonic, 
    walletInfo, 
    isInitialized, 
    generateNewWallet,
    importWallet,
    deleteWallet,
    getFormattedAddress 
  } = useWalletSeed();

  // Settings context - causes re-renders on any settings change  
  const { 
    settings, 
    updateSettings,
    getMempoolUrl,
    isInternetMode 
  } = useAppSettings();

  // Bitcoin context
  const { balance, transactions, refresh } = useBitcoin();

  const handleGenerate = () => {
    generateNewWallet(24);
  };

  const handleModeChange = (mode: ConnectionMode) => {
    updateSettings({ connectionMode: mode });
  };

  return (
    <View>
      <Text>Address: {getFormattedAddress()}</Text>
      <Text>Mode: {settings.connectionMode}</Text>
      <Button onPress={handleGenerate} title="Generate" />
    </View>
  );
}
*/

// ═══════════════════════════════════════════════════════════════════════════════
// APRÈS (avec stores Zustand)
// ═══════════════════════════════════════════════════════════════════════════════

import React from 'react';
import { View, Text, Button } from 'react-native';

// Import des stores Zustand - bien plus léger !
import { 
  useWalletStore, 
  useSettingsStore,
  useSettingsSelectors,
} from '@/stores';

// Import des types
import type { ConnectionMode } from '@/stores';

function WalletScreenNew() {
  // ✅ Sélecteurs granulaires - seuls les changements de ces valeurs causent un re-render
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const walletInfo = useWalletStore((state) => state.walletInfo);
  const isInitialized = useWalletStore((state) => state.isInitialized);
  const isGenerating = useWalletStore((state) => state.isGenerating);

  // ✅ Settings avec sélecteur multiple - une seule souscription
  const connectionMode = useSettingsStore((state) => state.connectionMode);
  const language = useSettingsStore((state) => state.language);

  // ✅ Actions - accès direct au store (ne cause pas de re-render hors du composant)
  const generateWallet = useWalletStore((state) => state.generateWallet);
  const importWallet = useWalletStore((state) => state.importWallet);
  const deleteWallet = useWalletStore((state) => state.deleteWallet);
  const setConnectionMode = useSettingsStore((state) => state.setConnectionMode);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const getMempoolUrl = useSettingsStore((state) => state.getMempoolUrl);
  const isInternetMode = useSettingsStore((state) => state.isInternetMode());

  // ✅ Computed values - utiliser des mémo si nécessaire
  const formattedAddress = React.useMemo(() => {
    if (walletInfo?.firstReceiveAddress) {
      return walletInfo.firstReceiveAddress.slice(0, 8) + '...' + walletInfo.firstReceiveAddress.slice(-8);
    }
    return 'No wallet';
  }, [walletInfo]);

  // ✅ Handlers
  const handleGenerate = async () => {
    try {
      await generateWallet(24);
    } catch (err) {
      console.error('Generation failed:', err);
    }
  };

  const handleModeChange = (mode: ConnectionMode) => {
    setConnectionMode(mode);
  };

  const handleImport = async (mnemonic: string) => {
    await importWallet(mnemonic);
  };

  return (
    <View>
      <Text>Address: {formattedAddress}</Text>
      <Text>Mode: {connectionMode}</Text>
      <Text>Internet: {isInternetMode ? 'Yes' : 'No'}</Text>
      <Button 
        onPress={handleGenerate} 
        title={isGenerating ? "Generating..." : "Generate Wallet"}
        disabled={isGenerating}
      />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATTERN OPTIMAL - Custom hooks pour réutilisation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Hook personnalisé qui combine les données du wallet
 * À placer dans un fichier hooks/useWallet.ts
 */
function useWallet() {
  // Lecture
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const walletInfo = useWalletStore((state) => state.walletInfo);
  const isInitialized = useWalletStore((state) => state.isInitialized);
  const isLoading = useWalletStore((state) => state.isLoading);
  const isGenerating = useWalletStore((state) => state.isGenerating);

  // Actions
  const getFormattedAddress = useWalletStore((state) => state.getFormattedAddress);
  const generateWallet = useWalletStore((state) => state.generateWallet);
  const importWallet = useWalletStore((state) => state.importWallet);
  const deleteWallet = useWalletStore((state) => state.deleteWallet);

  // Computed
  const formattedAddress = React.useMemo(() => {
    return getFormattedAddress();
  }, [walletInfo]);

  return {
    mnemonic,
    walletInfo,
    isInitialized,
    isLoading,
    isGenerating,
    formattedAddress,
    generateWallet,
    importWallet,
    deleteWallet,
  };
}

/**
 * Utilisation du hook personnalisé
 */
function WalletScreenWithCustomHook() {
  const { 
    formattedAddress, 
    isInitialized, 
    isGenerating,
    generateWallet 
  } = useWallet();

  return (
    <View>
      <Text>Address: {formattedAddress}</Text>
      <Button 
        onPress={() => generateWallet(24)}
        title={isGenerating ? "Generating..." : "Generate"}
        disabled={isGenerating}
      />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE DE CORRESPONDANCE - Anciens → Nouveaux
// ═══════════════════════════════════════════════════════════════════════════════

/*
┌─────────────────────────────────────────────────────────────────────────────┐
│ ANCIEN (providers)                    │ NOUVEAU (stores)                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ useWalletSeed()                       │ useWalletStore()                      │
│   .mnemonic                           │   useWalletStore(s => s.mnemonic)     │
│   .walletInfo                         │   useWalletStore(s => s.walletInfo)   │
│   .isInitialized                      │   useWalletStore(s => s.isInitialized)│
│   .isLoading                          │   useWalletStore(s => s.isLoading)    │
│   .isGenerating                       │   useWalletStore(s => s.isGenerating) │
│   .generateNewWallet(strength)        │   useWalletStore(s => s.generateWallet)│
│   .importWallet(mnemonic)             │   useWalletStore(s => s.importWallet) │
│   .deleteWallet()                     │   useWalletStore(s => s.deleteWallet) │
│   .exportWallet(password)             │   exportWalletEncrypted()             │
│   .getFormattedAddress()              │   useWalletStore(s => s.getFormattedAddr)│
├─────────────────────────────────────────────────────────────────────────────┤
│ useAppSettings()                      │ useSettingsStore()                    │
│   .settings.connectionMode            │   useSettingsStore(s => s.connectionMode)│
│   .settings.language                  │   useSettingsStore(s => s.language)   │
│   .settings.nostrRelays               │   useSettingsStore(s => s.nostrRelays)│
│   .updateSettings(partial)            │   useSettingsStore(s => s.updateSettings)│
│   .setConnectionMode(mode)            │   useSettingsStore(s => s.setConnectionMode)│
│   .getMempoolUrl()                    │   useSettingsSelectors().getMempoolUrl()│
│   .getCashuMintUrl()                  │   useSettingsSelectors().getCashuMintUrl()│
│   .getActiveRelayUrls()               │   useSettingsSelectors().getActiveRelayUrls()│
│   .isInternetMode                     │   useSettingsSelectors().isInternetMode()│
│   .isLoRaMode                         │   useSettingsSelectors().isLoRaMode() │
│   .isBridgeMode                       │   useSettingsSelectors().isBridgeMode()│
├─────────────────────────────────────────────────────────────────────────────┤
│ Nouveau!                              │ useUIStore()                          │
│                                       │   .setLoading(bool, msg?)             │
│                                       │   .showError(err)                     │
│                                       │   .openModal(type, data?)             │
│                                       │   .closeModal()                       │
│                                       │   .addToast(msg, type?, duration?)    │
└─────────────────────────────────────────────────────────────────────────────┘
*/

// ═══════════════════════════════════════════════════════════════════════════════
// CHECKLIST DE MIGRATION
// ═══════════════════════════════════════════════════════════════════════════════

/*
Pour chaque composant:

[ ] 1. Remplacer les imports providers par les imports stores
[ ] 2. Remplacer useWalletSeed() par useWalletStore(selector)
[ ] 3. Remplacer useAppSettings() par useSettingsStore(selector)  
[ ] 4. Extraire les actions avec useWalletStore(s => s.actionName)
[ ] 5. Remplacer .generateNewWallet par .generateWallet
[ ] 6. Vérifier que les sélecteurs sont granulaires (pas d'objet entier)
[ ] 7. Tester le composant isolément
[ ] 8. Vérifier les performances avec React DevTools Profiler
*/

export { WalletScreenNew, WalletScreenWithCustomHook, useWallet };
