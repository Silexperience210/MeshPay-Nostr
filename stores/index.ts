/**
 * Stores Index - Export de tous les stores Zustand
 * Remplace les providers React lourds par des stores légers
 */

// ─── Wallet Store ────────────────────────────────────────────────────────────
export {
  useWalletStore,
  useWalletInitialized,
  useWalletLoading,
  useWalletMnemonic,
  useWalletInfo,
  useWalletAddresses,
  exportWalletEncrypted,
  importWalletDecrypted,
} from './walletStore';
export type { WalletState } from './walletStore';

// ─── Settings Store ──────────────────────────────────────────────────────────
export {
  useSettingsStore,
  useSettings,
  useSettingsActions,
  useSettingsSelectors,
  useSettingsLoading,
  useConnectionMode,
  useLanguage,
} from './settingsStore';
export type {
  SettingsState,
  AppSettings,
  ConnectionMode,
  AppLanguage,
  NostrRelayConfig,
} from './settingsStore';

// ─── UI Store ────────────────────────────────────────────────────────────────
// NOTE: Les exports suivants ne sont pas encore utilisés par les composants
// existants (useLoading, useError, useModal, useToasts, useUIActions).
// Le store uiStore est fonctionnel et prêt à l'emploi. Pour l'activer,
// remplacer les gestions d'état UI locales (useState pour loading/error/modal)
// par ces hooks dans les composants concernés.
export {
  useUIStore,
  useLoading,
  useError,
  useModal,
  useToasts,
  useUIActions,
} from './uiStore';
export type {
  UIState,
  ModalType,
  ToastType,
  Toast,
} from './uiStore';
