# Tests d'intégration Hermès Engine

Ce dossier contient les tests d'intégration pour les Protocol Adapters de l'architecture Hermès Engine.

## Structure

```
engine/__tests__/integration/
├── NostrAdapter.integration.test.ts  # Tests pour l'adapter Nostr
├── LoRaAdapter.integration.test.ts   # Tests pour l'adapter LoRa/BLE
├── Bridge.integration.test.ts        # Tests pour le bridge bidirectionnel
├── setup.ts                          # Configuration des tests
└── README.md                         # Ce fichier
```

## Mocks

Les mocks sont situés dans `engine/mocks/` :

```
engine/mocks/
├── mockNostrClient.ts    # Mock du client Nostr
├── mockBleClient.ts      # Mock du client BLE/MeshCore
└── index.ts              # Exports
```

## Exécution des tests

```bash
# Tous les tests
npm test

# Tests spécifiques à l'engine
npm test -- --testPathPattern=engine

# Tests d'intégration uniquement
npm test -- --testPathPattern=integration

# Un fichier spécifique
npm test -- NostrAdapter.integration.test.ts

# Avec couverture
npm test -- --coverage --testPathPattern=engine
```

## Couverture des tests

### NostrAdapter
- ✅ Connexion et émission d'événements
- ✅ Envoi de DM via Nostr
- ✅ Envoi de messages de canal
- ✅ Réception de DM entrants
- ✅ Réception de messages de canal
- ✅ Fallback NIP-04/NIP-17
- ✅ Bridge LoRa→Nostr
- ✅ Gestion des déconnexions
- ✅ Reconnexion et redémarrage des listeners

### LoRaAdapter
- ✅ Connexion au gateway BLE
- ✅ Émission de TRANSPORT_CONNECTED
- ✅ Envoi de DM via LoRa
- ✅ Envoi de messages de canal
- ✅ Réception de DM entrants
- ✅ Réception de messages de canal
- ✅ Auto-bridge vers Nostr
- ✅ Gestion des contacts MeshCore
- ✅ Détection du type de contenu
- ✅ Gestion des déconnexions

### Bridge LoRa↔Nostr
- ✅ Bridge LoRa→Nostr
- ✅ Bridge Nostr→LoRa
- ✅ Déduplication des messages
- ✅ Gestion des échecs de bridge
- ✅ Flux bidirectionnel complet

## Notes

- Les tests utilisent `jest.useFakeTimers()` pour contrôler les timers
- Les mocks simulent fidèlement le comportement des clients réels
- Les tests vérifient le flux complet: Event → Adapter → Transport → Handler
