# 🚀 Hermès Engine

> Architecture event-sourced unifiée pour MeshPay-Nostr

[![Tests](https://img.shields.io/badge/tests-200%2B%20passing-success)](./__tests__)
[![Coverage](https://img.shields.io/badge/coverage-90%25%2B-blue)]()
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue)]()

---

## 📋 Table des matières

- [Concept](#concept)
- [Architecture](#architecture)
- [Installation](#installation)
- [Utilisation rapide](#utilisation-rapide)
- [API](#api)
- [Tests](#tests)
- [Migration depuis l'ancienne architecture](#migration)
- [Roadmap](./ROADMAP.md)

---

## 🎯 Concept

Hermès Engine remplace l'architecture "Providers Spaghetti" (11 Contexts React entrelacés) par un **bus d'événements unifié** où :

- Tous les transports (Nostr, LoRa, USB) communiquent via des événements standardisés
- Une seule source de vérité : SQLite Event Store
- Pas de circular dependencies
- UI réactive par souscription aux événements

### Avant / Après

```typescript
// ❌ AVANT : 11 providers qui s'appellent mutuellement
const { sendDM } = useNostr();
const { handleLoRaMessage } = useGateway();
const { bridgeLoraToNostr } = useMessagingBus();
// Circular dependencies, état dupliqué, debugging cauchemard

// ✅ APRÈS : Flux d'événements unifié
hermes.emit(EventBuilder.dm().to(pubkey).content('Hello!').build());
// Le routing est automatique, les adapters gèrent les transports
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        UI Layer                              │
│              (React Components + Hooks)                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │useHermes │    │useMessages│   │useConnection│
    └────┬─────┘    └────┬─────┘    └─────┬─────┘
         │               │                │
         └───────────────┼────────────────┘
                         ▼
              ┌──────────────────────┐
              │    HermesEngine      │
              │   (Bus d'événements) │
              └──────────┬───────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │NostrAdapter│  │LoRaAdapter│   │USBAdapter│
   └────┬─────┘   └────┬─────┘   └────┬─────┘
        │              │              │
        ▼              ▼              ▼
   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │  Nostr   │   │BLE/LoRa  │   │  Serial  │
   │ WebSocket│   │ Gateway  │   │   USB    │
   └──────────┘   └──────────┘   └──────────┘
```

---

## 📦 Installation

Hermès Engine est déjà intégré dans le projet MeshPay. Aucune installation supplémentaire n'est nécessaire.

Les dépendances requises sont déjà dans `package.json` :
- `expo-sqlite` : Persistance
- `zod` : Validation
- `react` / `react-native` : Hooks

---

## 🚀 Utilisation rapide

### 1. Initialisation (dans `_layout.tsx`)

```typescript
import { hermes, NostrAdapter, LoRaAdapter } from '@/engine';

// Au démarrage de l'app
const nostrAdapter = new NostrAdapter(hermes);
const loraAdapter = new LoRaAdapter(hermes);

hermes.registerAdapter(nostrAdapter);
hermes.registerAdapter(loraAdapter);

await hermes.start();
```

### 2. Envoyer un message

```typescript
import { EventBuilder, Transport, useHermes } from '@/engine';

function ChatScreen() {
  const { sendDM } = useHermes();
  
  const handleSend = async () => {
    await sendDM('npub1...', 'Hello!');
  };
}
```

### 3. Recevoir des messages

```typescript
import { useEffect } from 'react';
import { useHermes } from '@/engine';

function InboxScreen() {
  const { onDMReceived } = useHermes();
  
  useEffect(() => {
    return onDMReceived((event) => {
      console.log('Nouveau message de:', event.from);
      console.log('Contenu:', event.payload.content);
    });
  }, []);
}
```

---

## 📚 API

### HermesEngine (Bus central)

```typescript
class HermesEngine {
  // Enregistrer un adapter
  registerAdapter(adapter: ProtocolAdapter): void;
  
  // Démarrer/arrêter
  start(): Promise<void>;
  stop(): Promise<void>;
  
  // Émettre un événement
  emit(event: HermesEvent, targetTransport?: Transport): Promise<void>;
  
  // Souscrire aux événements
  on<T>(type: EventType, handler: EventHandler<T>): () => void;
  once<T>(type: EventType, handler: EventHandler<T>): () => void;
  subscribe(filter: EventFilter, handler: EventHandler): () => void;
  
  // Accéder aux adapters
  getAdapter(name: Transport): ProtocolAdapter | undefined;
  
  // Stats
  get stats(): { adapters: number; subscriptions: number; dedupSize: number };
}
```

### EventBuilder (Fluent API)

```typescript
const event = EventBuilder.dm()
  .to('npub1...')
  .content('Hello!')
  .encrypt('nip17')
  .build();

await hermes.emit(event, Transport.NOSTR);
```

### Hooks React

| Hook | Description |
|------|-------------|
| `useHermes()` | Accès au engine + helpers |
| `useMessages()` | Gestion conversations/messages |
| `useConnection()` | État des transports |
| `useWalletHermes()` | Wallet + events |
| `useBridge()` | Contrôle bridge LoRa↔Nostr |

Voir [hooks documentation](./hooks/) pour plus de détails.

---

## 🧪 Tests

### Lancer tous les tests

```bash
# Tests unitaires
npm test -- engine/__tests__/unit

# Tests d'intégration
npm test -- engine/__tests__/integration

# Tests E2E
npm test -- engine/__tests__/e2e

# Tous les tests de l'engine
npm test -- engine/
```

### Coverage

| Module | Coverage |
|--------|----------|
| HermesEngine | 100% |
| Adapters | 90%+ |
| Hooks | 85%+ |
| Utils | 80%+ |

---

## 🔄 Migration depuis l'ancienne architecture

Voir le [Guide de Migration](./MIGRATION_GUIDE.md) pour migrer progressivement.

### Résumé rapide

1. **Phase 1** : Intégrer Hermès en parallèle (double écriture)
2. **Phase 2** : Migrer les providers un par un
3. **Phase 3** : Supprimer l'ancien code

---

## 📁 Structure des fichiers

```
engine/
├── HermesEngine.ts          # Bus central
├── types.ts                 # Types fondamentaux
├── index.ts                 # Exports
├── ROADMAP.md              # Roadmap détaillée
├── MIGRATION_GUIDE.md      # Guide de migration
├── core/
│   ├── EventStore.ts       # Persistance SQLite
│   └── index.ts
├── adapters/
│   ├── NostrAdapter.ts     # Bridge Nostr
│   ├── LoRaAdapter.ts      # Bridge BLE/LoRa
│   └── index.ts
├── hooks/
│   ├── useHermes.ts        # Hook principal
│   ├── useMessages.ts      # Hook messages
│   ├── useConnection.ts    # Hook connexion
│   ├── useWalletHermes.ts  # Hook wallet
│   ├── useBridge.ts        # Hook bridge
│   └── index.ts
├── utils/
│   ├── EventBuilder.ts     # Fluent API
│   ├── EventValidator.ts   # Validation Zod
│   └── index.ts
├── mocks/
│   ├── mockNostrClient.ts  # Mock Nostr
│   ├── mockBleClient.ts    # Mock BLE
│   └── index.ts
└── __tests__/
    ├── unit/               # Tests unitaires
    ├── integration/        # Tests intégration
    └── e2e/                # Tests E2E
```

---

## 🤝 Contribution

### Ajouter un nouvel adapter

```typescript
import { ProtocolAdapter, HermesEngine } from '@/engine';

export class MyAdapter implements ProtocolAdapter {
  readonly name = Transport.MY_TRANSPORT;
  
  async start(): Promise<void> { /* ... */ }
  async stop(): Promise<void> { /* ... */ }
  async send(event: HermesEvent): Promise<void> { /* ... */ }
  onMessage(handler: (event: HermesEvent) => void): () => void { /* ... */ }
}

// Utilisation
const adapter = new MyAdapter(hermes);
hermes.registerAdapter(adapter);
```

---

## 📄 License

MIT - MeshPay Project

---

## 🙏 Remerciements

Architecture conçue pour résoudre les problèmes de l'ancien système "Providers Spaghetti" et offrir une base solide pour les futures fonctionnalités MeshPay.
