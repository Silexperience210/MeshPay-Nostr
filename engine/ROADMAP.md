# 🚀 ROADMAP HERMÈS ENGINE - MeshPay-Nostr

## 📋 Vue d'Ensemble

**Objectif** : Remplacer l'architecture "Providers Spaghetti" (11 contexts entrelacés) par un bus d'événements unifié, type-safe et testable.

**Philosophie** : Event-Sourced Architecture avec Single Source of Truth (SQLite Event Store)

---

## 🗓️ PHASES DE DÉVELOPPEMENT

### PHASE 1 : FONDATIONS (Semaine 1)
**Statut** : 🟡 En cours

#### 1.1 Core Engine ✅
- [x] `HermesEngine.ts` - Bus central avec routing
- [x] `types.ts` - Types stricts et enums
- [ ] Tests unitaires core (100% coverage)
- [ ] Documentation API

#### 1.2 Protocol Adapters 🔄
- [x] `NostrAdapter.ts` - Bridge Nostr complet
- [x] `LoRaAdapter.ts` - Bridge BLE/LoRa
- [ ] `USBAdapter.ts` - Bridge USB Serial (optionnel)
- [ ] Tests d'intégration par adapter

#### 1.3 Utilitaires ✅
- [x] `EventBuilder.ts` - Fluent API
- [ ] `CryptoWrapper.ts` - Abstraction crypto
- [ ] `EventStore.ts` - Persistance SQLite

**Livrable** : Engine fonctionnel avec tests

---

### PHASE 2 : INTÉGRATION PARALLÈLE (Semaine 2)
**Objectif** : Hermès coexiste avec l'ancienne architecture

#### 2.1 Double Écriture
- [ ] Modifier `_layout.tsx` pour initialiser Hermès
- [ ] Faire émettre des events depuis les providers existants
- [ ] Validation : Les deux systèmes fonctionnent

#### 2.2 Migration Wallet
- [ ] `WalletProvider` émet `EventType.WALLET_INITIALIZED`
- [ ] Tests E2E création wallet
- [ ] Tests E2E import/export

#### 2.3 Migration Messages (Partielle)
- [ ] `MessagesProvider` utilise Hermès pour l'envoi
- [ ] Réception via Hermès + ancien système
- [ ] Tests : Messages Nostr + LoRa

**Livrable** : Application stable avec double architecture

---

### PHASE 3 : MIGRATION COMPLÈTE (Semaine 3)
**Objectif** : Supprimer les anciens providers un par un

#### 3.1 Migration Nostr
- [ ] Remplacer `NostrProvider` par `NostrAdapter`
- [ ] Tests : Connexion, DMs, Channels, TxRelay
- [ ] Suppression ancien provider

#### 3.2 Migration Gateway
- [ ] `GatewayProvider` → Handlers Hermès
- [ ] Tests : Bridge LoRa↔Nostr, Relay jobs
- [ ] Suppression ancien provider

#### 3.3 Migration Messages
- [ ] `MessagesProvider` → Event handlers
- [ ] Tests : Conversations, encryption, chunks
- [ ] Suppression ancien provider

**Livrable** : Tous les providers migrés

---

### PHASE 4 : CLEANUP & OPTIMISATION (Semaine 4)
**Objectif** : Supprimer le code legacy

#### 4.1 Cleanup
- [ ] Supprimer les anciens providers
- [ ] Supprimer les types obsolètes
- [ ] Nettoyer les imports

#### 4.2 Performance
- [ ] Benchmark : Temps de démarrage
- [ ] Benchmark : Mémoire utilisée
- [ ] Optimisation si nécessaire

#### 4.3 Documentation
- [ ] Mise à jour README.md
- [ ] Guide de contribution
- [ ] Changelog

**Livrable** : Code propre, documenté, performant

---

## 📁 STRUCTURE FINALE

```
engine/
├── core/
│   ├── HermesEngine.ts          # Bus central
│   ├── EventStore.ts            # Persistance SQLite
│   ├── DeduplicationWindow.ts   # Déduplication
│   └── index.ts
├── adapters/
│   ├── BaseAdapter.ts           # Interface commune
│   ├── NostrAdapter.ts          # Bridge Nostr
│   ├── LoRaAdapter.ts           # Bridge BLE/LoRa
│   ├── USBAdapter.ts            # Bridge USB
│   └── index.ts
├── utils/
│   ├── EventBuilder.ts          # Fluent API
│   ├── CryptoWrapper.ts         # Abstraction crypto
│   ├── EventValidator.ts        # Validation schemas
│   └── Logger.ts                # Logging structuré
├── hooks/                       # React hooks
│   ├── useHermes.ts             # Hook principal
│   ├── useMessages.ts           # Hook messages
│   ├── useConnection.ts         # Hook connexion
│   └── index.ts
├── types/
│   ├── events.ts                # Types événements
│   ├── adapters.ts              # Types adapters
│   └── index.ts
├── __tests__/
│   ├── unit/                    # Tests unitaires
│   ├── integration/             # Tests intégration
│   └── e2e/                     # Tests E2E
├── mocks/                       # Mocks pour tests
└── ROADMAP.md                   # Ce fichier
```

---

## 🧪 STRATÉGIE DE TESTS

### Tests Unitaires (Jest)
```typescript
// HermesEngine.test.ts
describe('HermesEngine', () => {
  it('should route events to correct handlers');
  it('should deduplicate events');
  it('should handle async handlers');
  it('should unsubscribe correctly');
});
```

### Tests d'Intégration
```typescript
// adapters/NostrAdapter.test.ts
describe('NostrAdapter', () => {
  it('should connect to relays');
  it('should send DM via Nostr');
  it('should receive DM from Nostr');
  it('should bridge LoRa to Nostr');
});
```

### Tests E2E (Detox/Maestro)
```typescript
// e2e/messaging.test.ts
describe('Messaging Flow', () => {
  it('should send message Nostr and receive it');
  it('should bridge LoRa message to Nostr');
  it('should handle offline/online transition');
});
```

### Coverage Requirements
- Core Engine : 100%
- Adapters : 90%+
- Utils : 80%+

---

## 🎯 MILESTONES & CHECKPOINTS

### Checkpoint 1 : Core Stable
**Date** : Jour 3
**Critères** :
- [ ] `HermesEngine` passe tous les tests unitaires
- [ ] `NostrAdapter` mocké fonctionne
- [ ] Documentation API complète

### Checkpoint 2 : Intégration Validée
**Date** : Jour 7
**Critères** :
- [ ] Double écriture fonctionne sans régression
- [ ] Tests E2E création wallet passent
- [ ] Pas de crash en 24h de test

### Checkpoint 3 : Migration 50%
**Date** : Jour 14
**Critères** :
- [ ] Nostr et Gateway migrés
- [ ] Performance égale ou meilleure
- [ ] Tests E2E complets passent

### Checkpoint 4 : Release Candidate
**Date** : Jour 21
**Critères** :
- [ ] Tous les providers migrés
- [ ] Cleanup terminé
- [ ] Documentation à jour
- [ ] Audit sécurité passé

---

## 🔧 OUTILS & STACK

### Développement
- **TypeScript** : Strict mode
- **Zustand** : State management (conservé)
- **SQLite** : Event store + persistance

### Tests
- **Jest** : Tests unitaires
- **React Testing Library** : Tests composants
- **Detox/Maestro** : Tests E2E

### Documentation
- **TypeDoc** : Génération API docs
- **Storybook** : Composants UI (futur)

---

## ⚠️ RISQUES & MITIGATIONS

| Risque | Probabilité | Impact | Mitigation |
|--------|-------------|--------|------------|
| Régression wallet | Moyen | Critique | Tests E2E complets + rollback plan |
| Perf dégradée | Faible | Haut | Benchmarks avant/après |
| Complexité accrue | Moyen | Moyen | Documentation + formation |
| Delay | Moyen | Moyen | Phases découpées, livrables clairs |

---

## 📝 NOTES & DÉCISIONS

### 2024-04-05 : Création architecture initiale
- Architecture event-sourced validée
- Hermès Engine implémenté avec lazy loading crypto
- Adapters Nostr et LoRa fonctionnels

### Décisions à prendre
- [ ] Utiliser Zod pour validation events ?
- [ ] Implémenter EventStore SQLite maintenant ou plus tard ?
- [ ] Conserver les anciens types ou tout réécrire ?

---

## 👥 RESPONSABILITÉS

- **Architecture** : Claude (AI Assistant)
- **Tests** : Sub-agents spécialisés
- **Review** : Utilisateur (validation)
- **Intégration** : Pair programming utilisateur + AI

---

## 🎉 DÉFINITION DE "DONE"

Le projet est terminé quand :
1. ✅ Tous les providers legacy sont supprimés
2. ✅ Coverage tests > 90%
3. ✅ Documentation complète
4. ✅ Performance >= ancienne architecture
5. ✅ Aucun bug critique pendant 1 semaine de test
6. ✅ Utilisateur valide la migration

---

**Dernière mise à jour** : 2024-04-05
**Prochaine review** : Checkpoint 1 (Jour 3)
