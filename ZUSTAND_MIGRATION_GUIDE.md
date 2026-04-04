# Guide de Migration Zustand - MeshPay

## ✅ Résumé

Les stores Zustand ont été créés pour remplacer les providers lourds :

| Ancien Provider | Nouveau Store | Fichier |
|----------------|---------------|---------|
| `WalletSeedProvider` | `useWalletStore` | `stores/walletStore.ts` |
| `AppSettingsProvider` | `useSettingsStore` | `stores/settingsStore.ts` |
| - (nouveau) | `useUIStore` | `stores/uiStore.ts` |

## 📁 Fichiers créés

```
stores/
├── index.ts              # Export centralisé de tous les stores
├── walletStore.ts        # Store Wallet natif (SecureStore)
├── walletStore.web.ts    # Store Wallet web (localStorage)
├── settingsStore.ts      # Store Settings (AsyncStorage)
├── uiStore.ts            # Store UI (état volatile)
├── compat.tsx            # Couche compatibilité providers
├── migration.ts          # Outils de migration
├── MIGRATION_EXAMPLE.tsx # Exemples de migration
└── README.md             # Documentation complète
```

## 🚀 Intégration dans l'app

Le fichier `app/_layout.tsx` a été modifié pour :
1. **Retirer** `WalletSeedContext` et `AppSettingsContext`
2. **Conserver** les autres providers (migration progressive)
3. **Utiliser** les stores Zustand directement

### Modification du layout

```typescript
// AVANT (providers imbriqués)
<AppSettingsContext>
  <WalletSeedContext>
    <BitcoinContext>
      {/* ... */}
    </BitcoinContext>
  </WalletSeedContext>
</AppSettingsContext>

// APRÈS (stores Zustand)
{/* Les stores sont auto-initialisés */}
<BitcoinContext>
  {/* ... */}
</BitcoinContext>
```

## 📝 Utilisation dans les composants

### Avant (Context API)

```typescript
import { useWalletSeed } from '@/providers/WalletSeedProvider';
import { useAppSettings } from '@/providers/AppSettingsProvider';

function MyComponent() {
  const { mnemonic, isInitialized, generateNewWallet } = useWalletSeed();
  const { settings, updateSettings } = useAppSettings();
  
  return <Text>{settings.connectionMode}</Text>;
}
```

### Après (Zustand)

```typescript
import { useWalletStore, useSettingsStore, useWalletActions } from '@/stores';

function MyComponent() {
  // ✅ Sélecteurs granulaires - pas de re-render inutile
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const isInitialized = useWalletStore((state) => state.isInitialized);
  const connectionMode = useSettingsStore((state) => state.connectionMode);
  
  // ✅ Actions séparées
  const { generateWallet } = useWalletActions();
  const { setConnectionMode } = useSettingsStore();
  
  return <Text>{connectionMode}</Text>;
}
```

## 🔄 Migration progressive

### Option 1: Remplacement direct (recommandé)

Remplacez directement les imports et les hooks dans chaque composant.

### Option 2: Couche de compatibilité

Utilisez `compat.tsx` pendant la transition :

```typescript
import { WalletCompatProvider, useWalletCompat } from '@/stores/compat';

// Dans _layout.tsx
<WalletCompatProvider>
  <YourApp />
</WalletCompatProvider>

// Dans vos composants
const { mnemonic, generateNewWallet } = useWalletCompat();
```

## 📊 Table de correspondance complète

### Wallet

| Ancien | Nouveau |
|--------|---------|
| `useWalletSeed().mnemonic` | `useWalletStore(s => s.mnemonic)` |
| `useWalletSeed().walletInfo` | `useWalletStore(s => s.walletInfo)` |
| `useWalletSeed().isInitialized` | `useWalletStore(s => s.isInitialized)` |
| `useWalletSeed().receiveAddresses` | `useWalletStore(s => s.receiveAddresses)` |
| `useWalletSeed().changeAddresses` | `useWalletStore(s => s.changeAddresses)` |
| `useWalletSeed().isLoading` | `useWalletStore(s => s.isLoading)` |
| `useWalletSeed().isGenerating` | `useWalletStore(s => s.isGenerating)` |
| `useWalletSeed().isImporting` | `useWalletStore(s => s.isImporting)` |
| `useWalletSeed().generateError` | `useWalletStore(s => s.generateError)` |
| `useWalletSeed().generateNewWallet(n)` | `useWalletActions().generateWallet(n)` |
| `useWalletSeed().importWallet(m)` | `useWalletActions().importWallet(m)` |
| `useWalletSeed().deleteWallet()` | `useWalletActions().deleteWallet()` |
| `useWalletSeed().exportWallet(pwd)` | `useWalletActions().exportWallet(pwd)` |
| `useWalletSeed().importEncryptedWallet(json, pwd)` | `useWalletActions().importEncryptedWallet(json, pwd)` |
| `useWalletSeed().getFormattedAddress()` | `useWalletActions().getFormattedAddress()` |

### Settings

| Ancien | Nouveau |
|--------|---------|
| `useAppSettings().settings.connectionMode` | `useSettingsStore(s => s.connectionMode)` |
| `useAppSettings().settings.language` | `useSettingsStore(s => s.language)` |
| `useAppSettings().settings.nostrRelays` | `useSettingsStore(s => s.nostrRelays)` |
| `useAppSettings().updateSettings(p)` | `useSettingsStore().updateSettings(p)` |
| `useAppSettings().getMempoolUrl()` | `useSettingsSelectors().getMempoolUrl()` |
| `useAppSettings().getCashuMintUrl()` | `useSettingsSelectors().getCashuMintUrl()` |
| `useAppSettings().getActiveRelayUrls()` | `useSettingsSelectors().getActiveRelayUrls()` |
| `useAppSettings().isInternetMode` | `useSettingsSelectors().isInternetMode()` |
| `useAppSettings().isLoRaMode` | `useSettingsSelectors().isLoRaMode()` |
| `useAppSettings().isBridgeMode` | `useSettingsSelectors().isBridgeMode()` |

### UI (nouveau)

```typescript
import { useUIStore, useLoading, useModal, useToasts, useUIActions } from '@/stores';

// Loading
const { isLoading, message, progress } = useLoading();
const { setLoading, updateLoadingProgress } = useUIActions();

// Modals
const { isOpen, open, close } = useModal('receive');
const { activeModal, openModal, closeModal } = useUIActions();

// Toasts
const { toasts, add, remove } = useToasts();
const { addToast, showError } = useUIActions();
```

## ⚡ Hooks utilitaires

Des hooks pré-fabriqués sont disponibles :

```typescript
import { 
  useWalletInitialized,
  useWalletLoading,
  useWalletActions,
  useSettings,
  useSettingsActions,
  useSettingsSelectors,
  useSettingsLoading,
  useConnectionMode,
  useLanguage,
} from '@/stores';
```

## 🔧 Scripts de migration

### Vérifier l'état de migration

```typescript
import { checkMigrationStatus, forceMigration } from '@/stores/migration';

// Vérifier si les stores sont prêts
const status = checkMigrationStatus();
console.log(status.ready); // true/false

// Forcer la migration
const result = await forceMigration();
console.log(result.success); // true/false
```

## ✅ Checklist migration composant

Pour chaque composant à migrer:

- [ ] 1. Remplacer `import { useWalletSeed }` par imports stores
- [ ] 2. Remplacer `import { useAppSettings }` par imports stores
- [ ] 3. Convertir `const { x, y } = useWalletSeed()` en sélecteurs granulaires
- [ ] 4. Convertir `const { settings } = useAppSettings()` en sélecteurs
- [ ] 5. Extraire les actions avec `useWalletActions()` / `useSettingsActions()`
- [ ] 6. Remplacer `generateNewWallet` par `generateWallet`
- [ ] 7. Tester le composant isolément
- [ ] 8. Vérifier avec React DevTools Profiler

## 🐛 Dépannage

### Les stores ne sont pas hydratés

```typescript
const isHydrated = useWalletStore(s => s._hasHydrated);
if (!isHydrated) return <Loading />;
```

### Conflit entre anciens et nouveaux

Utilisez la couche de compatibilité dans `compat.tsx` pendant la transition.

### Erreur "cannot read property of undefined"

Vérifiez que vous utilisez bien un sélecteur:
```typescript
// ❌ Mauvais
const store = useWalletStore();
// ✅ Bon
const mnemonic = useWalletStore(s => s.mnemonic);
```

## 📚 Ressources

- Documentation Zustand: https://docs.pmnd.rs/zustand
- Fichier exemple: `stores/MIGRATION_EXAMPLE.tsx`
- Documentation détaillée: `stores/README.md`
