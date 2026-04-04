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
  useReceiveAddresses,
  useChangeAddresses,
  useWalletActions,
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
