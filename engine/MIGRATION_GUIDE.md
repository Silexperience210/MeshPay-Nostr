# Guide de Migration vers Hermès Engine

## 🎯 Objectif

Remplacer l'architecture spaghetti (11 providers entrelacés) par un flux unifié d'événements.

## 📊 Avant / Après

### ❌ AVANT: Architecture Spaghetti
```
UI Component
    ↓
useWalletSeed() → useNostr() → useBle() → useGateway()
    ↓                    ↓           ↓          ↓
11 Contexts qui s'appellent mutuellement
    ↓
Circular dependencies, refs partout, état dupliqué
```

**Problèmes:**
- 11 Providers React imbriqués
- Circular dependencies (MessagingBus → Nostr → Wallet → MessagingBus)
- État dupliqué entre Zustand, Context, Refs, SQLite
- Bridge LoRa↔Nostr éparpillé sur 4 fichiers
- Re-renders en cascade

### ✅ APRÈS: Architecture Hermès
```
UI Component
    ↓
hermes.on(EventType.DM_RECEIVED, handler)
    ↓
Hermès Engine (Event Bus unique)
    ↓
NostrAdapter / LoRaAdapter / USBAdapter
    ↓
Transports réels (WebSocket, BLE, Serial)
```

**Avantages:**
- 1 seul bus d'événements
- Pas de circular dependencies
- État unique dans SQLite (Event Store)
- Bridge centralisé
- UI réactive par souscription

---

## 🚀 Démarrage Rapide

### 1. Initialisation

```typescript
// App.tsx ou _layout.tsx
import { hermes, NostrAdapter, LoRaAdapter } from '@/engine';

// Une seule fois au démarrage
const nostrAdapter = new NostrAdapter(hermes);
const loraAdapter = new LoRaAdapter(hermes);

hermes.registerAdapter(nostrAdapter);
hermes.registerAdapter(loraAdapter);

await hermes.start();
```

### 2. Envoyer un message

```typescript
// AVANT
const { sendDM } = useNostr();
await sendDM(pubkey, content);

// APRÈS
import { EventBuilder } from '@/engine';

const event = EventBuilder.dm()
  .to(pubkey)
  .content('Hello!')
  .encrypt('nip17')
  .build();

await hermes.emit(event, Transport.NOSTR);
```

### 3. Recevoir des messages

```typescript
// AVANT
const { subscribeDMs } = useNostr();
useEffect(() => {
  return subscribeDMs((from, content, event) => {
    // traitement...
  });
}, []);

// APRÈS
useEffect(() => {
  return hermes.on(EventType.DM_RECEIVED, (event) => {
    console.log('De:', event.from);
    console.log('Contenu:', event.payload.content);
    // event.transport === Transport.NOSTR | Transport.LORA
  });
}, []);
```

### 4. Bridge automatique

```typescript
// Le bridge est maintenant géré par les adapters
// Quand un message arrive via LoRa:
loraAdapter.handleIncomingMessage(msg);
// → Émet loraAdapter.bridgeToNostr(event) automatiquement
// → NostrAdapter reçoit l'event BRIDGE_LORA_TO_NOSTR
// → Publie sur Nostr
```

---

## 🔄 Migration par Composant

### Migration de useWalletSeed()

```typescript
// AVANT
const { mnemonic, walletInfo, generateNewWallet } = useWalletSeed();

// APRÈS
const wallet = useWalletStore(); // Zustand direct

// Génération
const handleGenerate = async () => {
  await wallet.generateWallet(12);
  
  // Émettre événement système
  hermes.createEvent(EventType.WALLET_INITIALIZED, {
    nodeId: wallet.walletInfo?.firstReceiveAddress,
  });
};
```

### Migration de useMessages()

```typescript
// AVANT
const { sendMessage, conversations } = useMessages();

// APRÈS
const [conversations, setConversations] = useState([]);

useEffect(() => {
  // Charger depuis SQLite
  loadConversations().then(setConversations);
  
  // Écouter les nouveaux messages
  const unsub = hermes.on(EventType.DM_RECEIVED, async (event) => {
    // Sauvegarder
    await saveMessage(event);
    // Mettre à jour UI
    setConversations(prev => [...prev, event]);
  });
  
  return unsub;
}, []);

const sendMessage = async (to: string, content: string) => {
  const event = EventBuilder.dm()
    .to(to)
    .content(content)
    .build();
  
  // Envoie sur tous les transports connectés
  if (hermes.getAdapter(Transport.NOSTR)?.isConnected) {
    await hermes.emit(event, Transport.NOSTR);
  }
  if (hermes.getAdapter(Transport.LORA)?.isConnected) {
    await hermes.emit(event, Transport.LORA);
  }
};
```

### Migration du Gateway

```typescript
// AVANT
const { gatewayState, handleLoRaMessage } = useGateway();

// APRÈS
// Le gateway devient un simple handler d'événements
useEffect(() => {
  return hermes.on(EventType.BRIDGE_LORA_TO_NOSTR, async (event) => {
    // Relay job tracking
    await trackRelayJob(event);
    // Le NostrAdapter s'occupe du reste
  });
}, []);
```

---

## 📁 Structure des Fichiers

```
engine/
├── index.ts              # Exports publics
├── types.ts              # Types Hermès
├── HermesEngine.ts       # Bus central
├── adapters/
│   ├── index.ts
│   ├── NostrAdapter.ts   # Bridge Nostr
│   ├── LoRaAdapter.ts    # Bridge BLE/LoRa
│   └── USBAdapter.ts     # Bridge USB Serial (futur)
└── utils/
    └── EventBuilder.ts   # Fluent API
```

---

## 🧪 Tests

```typescript
// Tester sans vrais transports
const mockHermes = new HermesEngine({ debug: true });

// Mock adapter
const mockAdapter = {
  name: Transport.NOSTR,
  isConnected: true,
  start: jest.fn(),
  stop: jest.fn(),
  send: jest.fn(),
  onMessage: jest.fn(),
};

mockHermes.registerAdapter(mockAdapter);

// Test
mockHermes.on(EventType.DM_RECEIVED, (e) => {
  expect(e.payload.content).toBe('Hello');
});

mockHermes.emit({
  id: 'test-1',
  type: EventType.DM_RECEIVED,
  transport: Transport.NOSTR,
  timestamp: Date.now(),
  from: 'test',
  to: 'local',
  payload: { content: 'Hello' },
  meta: {},
});
```

---

## ⚡ Performance

- **Déduplication globale**: Un message Nostr reçu via 3 relays = 1 seul event
- **Lazy loading**: Les adapters ne démarrent que quand nécessaire
- **Moins de re-renders**: UI souscrite aux events, pas au state
- **Mémoire**: Event history configurable (5min par défaut)

---

## 🔒 Sécurité

- **Pas de mnemonic dans les events**: Seulement nodeId/npub
- **Validation**: Chaque adapter valide ses payloads
- **Sandboxing**: Les adapters sont isolés, communiquent par events

---

## 🎉 Bénéfices

| Aspect | Avant | Après |
|--------|-------|-------|
| Providers | 11 contexts | 1 engine |
| Circular deps | Oui | Non |
| Bridge LoRa↔Nostr | 4 fichiers | 1 adapter |
| Debug | Difficile | Event history |
| Tests | Complexe | Mock facile |
| New transport | Modifier N providers | Nouvel adapter |
