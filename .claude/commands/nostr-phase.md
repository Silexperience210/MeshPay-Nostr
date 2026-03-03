# /nostr-phase — Continuer l'intégration Nostr

Tu travailles sur le repo `C:\Users\Silex\MeshPay-Nostr` (fork de MeshPay).

## État actuel (2026-03-03)

**7 phases complètes — 228 tests verts — branche `main` pushée**

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

### ✅ Phase 5 — Forums/Channels Nostr (NIP-28)
- `deriveChannelId()`, `joinForum`/`leaveForum`/`sendMessage` Nostr, `nostrChannelUnsubs`, 22 tests

### ✅ Phase 6 — NIP-17 Gift Wrap DMs
- `utils/nostr-client.ts` : `deriveChannelId(channelName)` → sha256("meshpay:forum:"+name) hex 64 chars
  - Déterministe : tous les nœuds calculent le même channelId sans coordination préalable
- `providers/MessagesProvider.ts` :
  - `nostrChannelUnsubs` ref : Map<channelName, unsub fn>
  - `handleIncomingNostrChannelMessage()` : bridge kind:42 → DB + state (dedup, skip own)
  - `useEffect([nostrConnected])` : réabonne tous les forums sur reconnexion Nostr
  - `joinForum()` : subscribeChannel Nostr + MQTT
  - `leaveForum()` : unsub Nostr proprement
  - `sendMessage()` isForum : Nostr prioritaire (publishChannelMessage), MQTT fallback
  - Guards: Nostr accepté comme transport valide (BLE OU MQTT OU Nostr)
- `utils/__tests__/nostr-channels.test.ts` : 22 tests (185 total)

---

## Prochaines phases (dans l'ordre)

### Phase 6 ✅ — NIP-17 Gift Wrap DMs — TERMINÉE
- `utils/nostr-client.ts` : Kind.Seal=13, PrivateDirectMessage=14, GiftWrap=1059
- `publishDMSealed()` : 2 wraps (destinataire + copie expéditeur), clés éphémères, NIP-44
- `subscribeDMsSealed()` : kind:1059 #p=myPubKey, nip17.unwrapEvent()
- Rétrocompat : subscribeDMs() (kind:4) actif en parallèle
- `providers/NostrProvider.tsx` : méthodes exposées
- 20 tests → **205 verts**

### Phase 7 ✅ — Discovery / Présence Nostr — TERMINÉE
- `PresencePayload`, `publishMetadata` (kind:0), `publishPresence` (kind:9001 #t=presence), `subscribePresence`
- `NostrProvider` : publie kind:0 au connect, expose nodeId, publishPresence/subscribePresence
- `MessagesProvider` : subscribePresence → radarPeers + publishPresence sur GPS change
- 23 tests → **228 verts**

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
- **deriveChannelId** : préfixe "meshpay:forum:" + normalize toLowerCase().trim()
- **isConnected getter** : vérifie `relayStatus.some(s => s === 'connected')` — ne pas mocker `_connected`

## Commandes utiles

```bash
cd "C:\Users\Silex\MeshPay-Nostr"
npx jest --no-coverage                    # tous les tests
npx jest --no-coverage nostr-client       # tests Phase 1 uniquement
npx jest --no-coverage messaging-bus      # tests Phase 2 uniquement
npx jest --no-coverage tx-relay           # tests Phase 3 uniquement
npx jest --no-coverage nostr-channels     # tests Phase 5 uniquement
git log --oneline -8                      # voir les commits récents
```

## Pour continuer : indique simplement "phase 6", "phase 7", etc.
