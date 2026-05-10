# Stores Zustand - MeshPay

Ce dossier contient les stores Zustand qui remplacent les providers React traditionnels pour une meilleure performance et une architecture plus simple.

## 🎯 Pourquoi Zustand ?

| Avantages | Context API | Zustand |
|-----------|-------------|---------|
| Re-renders | Cascade de re-renders | Sélecteurs granulaires |
| Boilerplate | Élevé (Provider + Hook) | Minimal |
| Performance | Moyenne | Excellente |
| DevTools | Limité | Excellent |
| Async/Persist | Manuel | Middleware intégré |

## 📁 Structure

```
stores/
├── index.ts              # Export centralisé
├── walletStore.ts        # Gestion du wallet (SecureStore)
├── walletStore.web.ts    # Version web (localStorage)
├── settingsStore.ts      # Paramètres app (AsyncStorage)
├── uiStore.ts            # État UI global
└── compat.tsx            # Couche de compatibilité
```

## 🚀 Usage

### Import des stores

```typescript
// Import direct du store
import { useWalletStore, useSettingsStore } from '@/stores';

// Import des hooks utilitaires
import { 
  useWalletInitialized, 
  useWalletActions,
  useSettings,
  useSettingsActions,
  useLoading,
  useModal 
} from '@/stores';
```

### Lecture du state (sélecteurs)

```typescript
// ✅ Bon - Utiliser un sélecteur
const mnemonic = useWalletStore((state) => state.mnemonic);
const isInitialized = useWalletInitialized();

// ❌ Mauvais - Souscrit à tout le store
const store = useWalletStore(); // Re-render à chaque changement
```

### Actions

```typescript
function MyComponent() {
  const { generateWallet, importWallet, deleteWallet } = useWalletActions();
  const { setConnectionMode, toggleNotifications } = useSettingsActions();
  const { openModal, showError } = useUIActions();

  const handleGenerate = async () => {
    try {
      await generateWallet(24);
    } catch (err) {
      showError(err);
    }
  };

  return (
    <Button onPress={handleGenerate} title="Générer Wallet" />
  );
}
```

## 🔄 Migration depuis les Providers

### Avant (Context API)

```typescript
import { useWalletSeed } from '@/providers/WalletSeedProvider';

function MyComponent() {
  const { 
    mnemonic, 
    isInitialized, 
    generateNewWallet 
  } = useWalletSeed();
  
  // ...
}
```

### Après (Zustand)

```typescript
import { useWalletStore, useWalletActions } from '@/stores';

function MyComponent() {
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const isInitialized = useWalletStore((state) => state.isInitialized);
  const { generateWallet } = useWalletActions();
  
  // Note: generateNewWallet devient generateWallet
  // ...
}
```

## 📊 Stores

### WalletStore

Gère le mnemonic, les adresses dérivées et l'état du wallet.

**Persistence**: SecureStore (Android Keystore / iOS Keychain)

```typescript
interface WalletState {
  mnemonic: string | null;
  walletInfo: DerivedWalletInfo | null;
  receiveAddresses: string[];
  changeAddresses: string[];
  isInitialized: boolean;
  isLoading: boolean;
  isGenerating: boolean;
  isImporting: boolean;
  
  // Actions
  generateWallet(strength?: 12 | 24): Promise<void>;
  importWallet(mnemonic: string): Promise<void>;
  deleteWallet(): Promise<void>;
  exportWallet(password: string): string;
  importEncryptedWallet(backupJson: string, password: string): Promise<void>;
}
```

### SettingsStore

Gère les paramètres de l'application.

**Persistence**: AsyncStorage

```typescript
interface SettingsState {
  connectionMode: 'internet' | 'lora' | 'bridge';
  language: 'en' | 'fr' | 'es';
  mempoolUrl: string;
  defaultCashuMint: string;
  nostrRelays: NostrRelayConfig[];
  // ... et plus
  
  // Actions
  setConnectionMode(mode: ConnectionMode): void;
  toggleGateway(): void;
  updateRelayOrder(relays: NostrRelayConfig[]): void;
  // ... et plus
}
```

### UIStore

Gère l'état UI global (loading, modals, toasts, erreurs).

**Persistence**: Aucune (state volatile)

```typescript
interface UIState {
  isLoading: boolean;
  loadingMessage: string | null;
  activeModal: ModalType;
  toasts: Toast[];
  error: Error | null;
  
  // Actions
  setLoading(loading: boolean, message?: string): void;
  openModal(modal: ModalType, data?: any): void;
  closeModal(): void;
  addToast(message: string, type?: ToastType): string;
  showError(error: Error | string): void;
}
```

## 🛠️ DevTools

Zustand fonctionne avec Redux DevTools. Ouvrez les DevTools dans votre navigateur pour voir les actions et les changements de state.

## 🧪 Tests

Les stores peuvent être testés facilement sans provider:

```typescript
import { useWalletStore } from '@/stores/walletStore';

// Reset le store avant chaque test
beforeEach(() => {
  useWalletStore.setState({
    mnemonic: null,
    isInitialized: false,
    // ...
  });
});

test('generateWallet crée un nouveau wallet', async () => {
  const { generateWallet } = useWalletStore.getState();
  await generateWallet(12);
  
  expect(useWalletStore.getState().isInitialized).toBe(true);
  expect(useWalletStore.getState().mnemonic).toBeTruthy();
});
```

## 📚 Bonnes Pratiques

1. **Toujours utiliser des sélecteurs** pour éviter les re-renders inutiles
2. **Séparer la lecture et l'écriture** - utiliser des hooks séparés
3. **Ne pas persister de données dérivées** - les recalculer au chargement
4. **Utiliser les hooks utilitaires** (`useWalletActions`, `useSettings`) pour un code plus propre
