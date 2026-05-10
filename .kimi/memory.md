# 🧠 Mémoire - MeshPay-Nostr Project

**Dernière mise à jour** : 5 Avril 2024  
**Version** : Hermès Engine v1.0.1

---

## 📱 Projet Overview

**Nom** : MeshPay-Nostr  
**Type** : React Native / Expo App  
**Objectif** : Wallet Bitcoin + Messagerie P2P (Nostr + LoRa)  

**Architecture actuelle** : Migration de "Providers Spaghetti" vers "Hermès Engine"

---

## 🔧 Stack Technique

### Core
- **React Native** : 0.76.7
- **Expo SDK** : ~52.0.0
- **TypeScript** : Strict mode
- **Zustand** : State management
- **expo-sqlite** : Persistance

### Crypto & Bitcoin
- **bitcoinjs-lib** : Transactions Bitcoin
- **@scure/bip32/bip39** : Mnemonic, HD wallets
- **@noble/hashes/curves** : Cryptographie (secp256k1, AES-GCM)
- **@noble/ciphers** : Chiffrement

### Protocoles
- **Nostr** : NIP-04/17/28/9001
- **MeshCore** : Protocole LoRa natif (ESP32 + SX1262)
- **Cashu** : Ecash protocol
- **BLE** : react-native-ble-manager

---

## 🏗️ Architecture Hermès Engine

### Structure
```
engine/
├── HermesEngine.ts          # Bus d'evenements
├── types.ts                 # Types fondamentaux
├── core/
│   └── EventStore.ts        # SQLite persistence
├── adapters/
│   ├── NostrAdapter.ts      # Bridge Nostr
│   └── LoRaAdapter.ts       # Bridge MeshCore LoRa
├── hooks/
│   ├── useHermes.ts
│   ├── useMessages.ts
│   ├── useConnection.ts
│   ├── useWalletHermes.ts
│   └── useBridge.ts
└── utils/
    ├── EventBuilder.ts
    └── EventValidator.ts
```

### Points Clés à Retenir

1. **LoRaAdapter utilise MeshCore nativement** :
   - `BleGatewayClient` pour BLE
   - `meshcore-protocol.ts` pour parsing
   - Commandes : `CMD_SEND_TXT_MSG`, `CMD_SYNC_CONTACTS`
   - Events : `PUSH_TEXT_MSG`, `PUSH_ADVERT`
   - Chiffrement : secp256k1 (DMs) / AES-PSK (channels)

2. **Bridge automatique** :
   - LoRa → Nostr : Quand `autoBridgeToNostr: true`
   - Nostr → LoRa : Via `EventType.BRIDGE_NOSTR_TO_LORA`

3. **Tests** : 242+ tests, 90%+ coverage

---

## 📝 Patterns Utilisés

### Event Building
```typescript
const event = EventBuilder.dm()
  .to('npub1...')
  .content('Hello')
  .encrypt('nip17')
  .build();

await hermes.emit(event, Transport.NOSTR);
```

### Subscription
```typescript
useEffect(() => {
  return hermes.on(EventType.DM_RECEIVED, handler);
}, []);
```

### Lazy Loading Crypto
```typescript
// Dans walletStore.ts
const loadBitcoinModule = async () => {
  if (!bitcoinModule) {
    bitcoinModule = await import('@/utils/bitcoin');
  }
  return bitcoinModule;
};
```

---

## ⚠️ Points de Vigilance

### Crypto Polyfill
- Toujours charger `polyfills.ts` AVANT `@noble/hashes`
- Utiliser `globalThis.crypto` pas seulement `global.crypto`
- Lazy loading recommandé pour éviter race conditions

### BLE/MeshCore
- Permissions Android requises : BLUETOOTH_SCAN, BLUETOOTH_CONNECT
- Auto-connect peut échouer si device pas appairé
- Contacts sync async, pas immédiatement disponibles

### Nostr
- SimplePool recréé à chaque reconnexion
- Subscriptions mortes après reconnexion → restartListeners()
- NIP-17 (sealed) préféré, fallback NIP-04

---

## 🗂️ Fichiers Importants

### Config
- `app.json` : Expo config, plugins, intents
- `package.json` : Dépendances
- `tsconfig.json` : Paths `@/*`

### Entry Points
- `app/_layout.tsx` : Root layout, providers
- `app/polyfills.ts` : DOIT être premier import
- `app/index.tsx` : Entry point

### Core Utils
- `utils/bitcoin.ts` : Mnemonic, adresses, validation
- `utils/encryption.ts` : E2E encryption
- `utils/database.ts` : SQLite wrapper
- `utils/nostr-client.ts` : Client Nostr
- `utils/ble-gateway.ts` : Client BLE MeshCore
- `utils/meshcore-protocol.ts` : Protocole binaire

---

## 🐛 Bugs Connus (Historique)

### Fixés
1. **Wallet generation freeze** → Lazy loading crypto
2. **Circular dependencies** → Hermès Engine
3. **Polyfill timing** → globalThis.crypto + dynamic imports

### À Surveiller
- Double-émission d'events (déduplication gère)
- Memory leaks dans subscriptions (cleanup React)
- Race conditions BLE (isConnected flag)

---

## 🚀 Roadmap

### Phase 1 : Foundation ✅
- Hermès Engine core
- NostrAdapter + LoRaAdapter
- Tests 90%+

### Phase 2 : Parallel Integration 🔄
- Double écriture legacy + Hermès
- Validation non-régression

### Phase 3 : Migration
- Remplacer providers un par un
- Tests E2E complets

### Phase 4 : Cleanup
- Supprimer legacy
- Optimisations

---

## 💡 Conseils pour Moi-Même

### Quand on me demande de modifier le wallet
1. Vérifier lazy loading crypto
2. Tests avec mock de SecureStore
3. Validation mnemonic avant save
4. Event WALLET_INITIALIZED émis

### Quand on me demande de modifier LoRa
1. Vérifier protocole MeshCore utilisé
2. Tests avec mockBleClient
3. Vérifier chiffrement (secp256k1/AES)
4. Bridge vers Nostr si activé

### Quand on me demande de modifier Nostr
1. Vérifier reconnexion pool
2. Tests avec mockNostrClient
3. NIP-17 vs NIP-04 fallback
4. Restart listeners après reconnect

### Quand on me demande de créer un tag
1. Vérifier tous les tests passent
2. Message de commit détaillé
3. Tag annoté avec contexte
4. Mentionner protocole MeshCore si LoRa

---

## 📚 Documentation Créée

- `engine/README.md` : Usage guide
- `engine/ROADMAP.md` : Plan 4 phases
- `engine/MIGRATION_GUIDE.md` : Migration legacy
- `engine/SUMMARY.md` : Synthèse dev

---

## 🔗 Références Utiles

- MeshCore Protocol : `utils/meshcore-protocol.ts`
- Nostr Client : `utils/nostr-client.ts`
- Event Store : `engine/core/EventStore.ts`
- Tests : `engine/__tests__/`

---

**Note pour futur moi** : Ce projet utilise le protocole **MeshCore** pour LoRa, pas un protocole custom. Toujours vérifier la documentation MeshCore avant de modifier le LoRaAdapter.
