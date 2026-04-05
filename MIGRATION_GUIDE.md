# Guide de Migration - Hermès Engine v2.0

## Résumé

L'architecture a été migrée de React Context vers Hermès Engine (event-sourced). Ce guide vous aide à migrer votre code existant vers la nouvelle architecture.

## Table des matières

- [Changements principaux](#changements-principaux)
- [Migration par module](#migration-par-module)
- [Timeline de déprécation](#timeline-de-déprécation)
- [Avantages de la nouvelle architecture](#avantages-de-la-nouvelle-architecture)
- [FAQ](#faq)
- [Support](#support)

---

## Changements principaux

### 1. Nostr / Connexion

**Avant:**
```tsx
import { useNostr } from '@/providers/NostrProvider';

function Component() {
  const { isConnected, publicKey, publishDM, subscribeDMs } = useNostr();
  // ...
}
```

**Après:**
```tsx
import { useNostrHermes } from '@/engine/hooks';

function Component() {
  const { isConnected, publicKey, publishDM, subscribeDMs } = useNostrHermes();
  // ...
}
```

**API identique** - Les méthodes et propriétés restent les mêmes.

---

### 2. Messages / Messagerie

**Avant:**
```tsx
import { useMessagingBus } from '@/providers/MessagingBusProvider';

function Component() {
  const { sendDM, subscribe, lastMessage } = useMessagingBus();
  
  useEffect(() => {
    const unsub = subscribe((msg) => {
      console.log('Message reçu:', msg);
    });
    return unsub;
  }, []);
  
  const handleSend = () => {
    sendDM({ toNodeId: 'MESH-1234', toNostrPubkey: '...', content: 'Hello' });
  };
  // ...
}
```

**Après:**
```tsx
import { useMessages, messageService } from '@/engine';

function Component() {
  const { conversations, sendDM, isLoading } = useMessages();
  
  // Ou utiliser directement le service:
  const handleSend = async () => {
    await messageService.sendDM({
      toNodeId: 'MESH-1234',
      toNostrPubkey: '...',
      content: 'Hello'
    });
  };
  
  // Accès aux conversations
  const myConversation = conversations.get('MESH-1234');
  // ...
}
```

---

### 3. Gateway (Bridge LoRa↔Nostr)

**Avant:**
```tsx
import { useGateway } from '@/providers/GatewayProvider';

function Component() {
  const { gatewayState, activateGateway, deactivateGateway } = useGateway();
  // ...
}
```

**Après:**
```tsx
import { useGateway } from '@/engine/hooks';

function Component() {
  const { status, startGateway, stopGateway, stats } = useGateway();
  // ...
}
```

**Changements API:**
| Ancien | Nouveau |
|--------|---------|
| `gatewayState.isActive` | `status.isRunning` |
| `gatewayState.mode` | `status.mode` |
| `activateGateway()` | `startGateway()` |
| `deactivateGateway()` | `stopGateway()` |
| `gatewayState.stats` | `stats` |

---

### 4. Événements / Bus global

**Avant:**
```tsx
import { messagingBus } from '@/utils/messaging-bus';

// Envoi
messagingBus.sendDM({ toNodeId, toNostrPubkey, content });

// Réception
const unsub = messagingBus.subscribe((msg) => {
  console.log('Message:', msg);
});
```

**Après:**
```tsx
import { hermes, EventType, messageService } from '@/engine';

// Émettre un événement
await hermes.createEvent(
  EventType.DM_SENT,
  { content, contentType: 'text' },
  { from: nodeId, to: recipientId, transport: Transport.NOSTR }
);

// S'abonner aux événements
const unsub = hermes.on(EventType.DM_RECEIVED, (event) => {
  console.log('DM reçu:', event.payload);
});

// Ou utiliser le service de messages
await messageService.sendDM({ toNodeId, toNostrPubkey, content });
```

---

### 5. Identité unifiée

**Nouveau dans Hermès:**
```tsx
import { useUnifiedIdentity } from '@/engine/hooks';

function Component() {
  const { 
    hasIdentity,      // boolean - wallet initialisé?
    nodeId,           // ex: "MESH-A7F2"
    npub,             // clé publique Nostr (bech32)
    publicKey,        // clé publique hex
    displayName,      // nom affiché
    updateProfile,    // fonction de mise à jour
  } = useUnifiedIdentity();
  
  // ...
}
```

---

## Timeline de déprécation

| Version | Action |
|---------|--------|
| **v3.3.0** (actuel) | ✅ Providers legacy marqués `@deprecated` |
| **v3.4.0** | ⚠️ Warnings dans la console en mode développement |
| **v4.0.0** | 🗑️ Suppression des providers legacy |

### Fichiers concernés par la déprécation

- `providers/NostrProvider.tsx` → Remplacé par `useNostrHermes()`
- `providers/MessagingBusProvider.tsx` → Remplacé par `useMessages()` et `messageService`
- `providers/GatewayProvider.ts` → Remplacé par `useGateway()` de Hermès
- `utils/messaging-bus.ts` → Remplacé par `MessageService` et `hermes`

---

## Avantages de la nouvelle architecture

### 1. **Performance**
- Plus de re-renders inutiles des Context Providers
- Subscriptions ciblées par événement
- Moins de re-rendus en cascade

### 2. **Testabilité**
- Event-sourced = tests déterministes
- Mock facile des événements Hermès
- Tests unitaires sans contexte React

### 3. **Débogage**
- Time-travel debugging avec EventStore
- Historique complet des événements
- Replay possible des sessions

### 4. **Extensibilité**
- Ajouter un nouveau transport = 1 adapter
- Plugins faciles à intégrer
- Architecture modulaire

### 5. **Type safety**
- Types stricts pour tous les événements
- Autocomplétion IDE optimale
- Détection d'erreurs à la compilation

---

## FAQ

### Q: Puis-je continuer à utiliser les anciens providers ?
**R:** Oui, pour l'instant. Les providers legacy fonctionnent toujours mais affichent des warnings `@deprecated`. La migration est recommandée dès maintenant.

### Q: Les hooks Hermès sont-ils retrocompatibles ?
**R:** Presque. `useNostrHermes` a la même API que `useNostr`. `useGateway` a quelques changements mineurs (voir tableau ci-dessus).

### Q: Comment savoir si Hermès est initialisé ?
**R:** Utilisez `hermes.isStarted` ou le hook `useHermes()`:
```tsx
const { isStarted, stats } = useHermes();
```

### Q: Puis-je utiliser les deux systèmes en parallèle ?
**R:** Oui, pendant la phase de transition. Hermès et les providers legacy peuvent coexister. Les événements sont synchronisés entre les deux systèmes (double écriture).

### Q: Quand les providers legacy seront-ils supprimés ?
**R:** Prévu pour la v4.0.0 (dans ~2-3 mois).

---

## Support

En cas de problème lors de la migration:

1. Consultez la documentation de l'Engine: `engine/README.md`
2. Ouvrez une issue sur GitHub avec le tag `migration`
3. Rejoignez le canal Matrix: `#meshpay-dev:matrix.org`

---

<div align="center">

**[⬆ Retour en haut](#guide-de-migration---hermès-engine-v20)**

Fait avec ❤️ par l'équipe MeshPay-Nostr

</div>
