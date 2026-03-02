# /nostr-phase — Continuer l'intégration Nostr

Tu travailles sur le repo `C:\Users\Silex\MeshPay-Nostr` (fork de MeshPay).

## État actuel (2026-03-02)

**4 phases complètes — 163 tests verts — branche `main` pushée**

### ✅ Phase 1 — Fondations Nostr
- `utils/nostr-client.ts` : NIP-06 (dérivation `m/44'/1237'/0'/0/0`), NIP-04 (sans crypto.subtle via @noble), SimplePool, offline queue, double-validation events
- `providers/NostrProvider.tsx` : auto-connect quand wallet initialisé, expose publishDM/subscribeDMs/publishTxRelay...
- `utils/__tests__/nostr-client.test.ts` : 57 tests

### ✅ Phase 2 — MessagingBus dual-transport
- `utils/messaging-bus.ts` : Nostr prioritaire, MQTT fallback, DeduplicateWindow (5min/1000), bridge LoRa→Nostr
  - FIX : `setLocalIdentity()` redémarre les listeners Nostr si subscribers déjà actifs
- `providers/MessagingBusProvider.tsx` : contexte React, sync identité, lastMessage
- `utils/__tests__/messaging-bus.test.ts` : 24 tests (78 total)

### ✅ Phase 3 — TX Relay Bitcoin/Cashu (kind:9001)
- `utils/tx-relay.ts` : TxRelayGateway (listen + broadcast mempool.space + ack Cashu), sendBitcoinTxViaNostr (timeout 60s), sendCashuTokenViaNostr (best-effort 30s), isTxAlreadyKnown
- `providers/TxRelayProvider.tsx` : auto-start gateway, pendingRelays state, gatewayStats polling
- `utils/__tests__/tx-relay.test.ts` : 28 tests (163 total)

### ✅ Phase 4 — App Integration
- `app/_layout.tsx` : NostrContext → MessagingBusContext → TxRelayContext insérés dans l'arbre
- `providers/MessagesProvider.ts` : bridge messagingBus → DMs Nostr → conversations DB (+ détection Cashu inline)
- `providers/BitcoinProvider.ts` : fallback sendBitcoin → TxRelay si erreur réseau
- `app/(tabs)/(messages)/index.tsx` : badge Nostr ●/○ dans status bar
- `app/(tabs)/wallet/index.tsx` : bannière Gateway, indicateur pending relay

---

## Prochaines phases (dans l'ordre)

### Phase 5 — Forums/Channels Nostr
**Objectif** : les forums fonctionnent via Nostr (NIP-28) en plus de MQTT.

Fichiers à modifier :
- `providers/MessagesProvider.ts` :
  - `joinForum()` : si Nostr connecté → `nostrClient.subscribeChannel(channelId, handler)` + MQTT
  - `sendMessage()` pour forums : si Nostr → `nostrClient.publishChannelMessage(channelId, text)`
  - Bridge incoming `msg.type === 'channel'` depuis messagingBus → dispatcher dans le bon forum
- `utils/__tests__/messaging-bus.test.ts` ou nouveau fichier : tester le bridge channel

### Phase 6 — NIP-17 Gift Wrap DMs (upgrade sécurité)
**Objectif** : remplacer NIP-04 (DMs visibles sur relays) par NIP-17 (sealed sender + gift wrap).

Fichiers à modifier :
- `utils/nostr-client.ts` : nouvelles méthodes `publishDMSealed()` + `subscribeDMsSealed()`
  - kind:13 (Seal) + kind:1059 (Gift Wrap) selon NIP-17
  - Rétrocompat : continuer à lire NIP-04 (kind:4) pendant la transition
- `providers/NostrProvider.tsx` : exposer les nouvelles méthodes
- Tests : round-trip NIP-17 Alice ↔ Bob

### Phase 7 — Discovery / Présence Nostr
**Objectif** : découvrir les pairs MeshPay sur Nostr sans MQTT.

Fichiers à modifier :
- `providers/NostrProvider.tsx` : publier kind:0 au connect `{name, nodeId, about: "MeshPay node"}`
- `utils/nostr-client.ts` : `publishPresence(nodeId, lat?, lng?)` → kind:9001 type=presence
- `providers/MessagingBusProvider.tsx` ou nouveau `providers/NostrDiscoveryProvider.tsx` : subscribe aux présences Nostr, MAJ radarPeers
- `providers/MessagesProvider.ts` : brancher les présences Nostr sur `setRadarPeers()`

### Phase 8 — Suppression MQTT (condition : Phases 5-7 stables en prod)
**Objectif** : retirer MQTT complètement, ne garder que Nostr.

Fichiers à supprimer/nettoyer :
- `utils/mqtt-client.ts` → supprimer
- `providers/GatewayProvider.ts` → retirer la partie MQTT (garder le gateway LoRa)
- `providers/MessagesProvider.ts` → retirer les handlers MQTT directs, garder seulement le bridge Nostr
- Retirer `mqttState` de l'interface publique `MessagesState`
- Retirer `messaging-bus.ts` les imports MQTT

---

## Rappels techniques importants

- **crypto.subtle absent sur Hermes** → NIP-04 via `@noble/curves/secp256k1` + `@noble/ciphers/aes` (AES-CBC)
- **nostr-tools ESM dans Jest** → `transformIgnorePatterns` doit inclure `nostr-tools` dans `package.json`
- **verifyEvent() ne recompute pas le hash** → toujours doubler avec `getEventHash(e) !== e.id`
- **Race condition identity dans MessagingBus** → `setLocalIdentity()` redémarre les Nostr listeners si subscribers actifs
- **Kind TxRelay** : `9001` (défini dans `utils/nostr-client.ts` → `Kind.TxRelay`)
- **Chemin de dérivation Nostr** : `m/44'/1237'/0'/0/0` (NIP-06 standard)
- **nostrClient** : singleton global exporté depuis `utils/nostr-client.ts`
- **messagingBus** : singleton global exporté depuis `utils/messaging-bus.ts`

## Commandes utiles

```bash
cd "C:\Users\Silex\MeshPay-Nostr"
npx jest --no-coverage                    # tous les tests
npx jest --no-coverage nostr-client       # tests Phase 1 uniquement
npx jest --no-coverage messaging-bus      # tests Phase 2 uniquement
npx jest --no-coverage tx-relay           # tests Phase 3 uniquement
git log --oneline -8                      # voir les commits récents
```

## Pour continuer : indique simplement "phase 5", "phase 6", etc.
