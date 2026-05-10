# MeshPay-Nostr — Notes d'architecture (session 2026-04-03)

## Stack technique
- React Native + Expo SDK 54 (RN 0.81.5)
- `bun` comme package manager (bun.lock strict — pas d'ajout de dépendances sans bun add)
- GitHub Actions : OTA sur push main, APK sur tag `apk-*`
- EAS OTA channel : `preview`
- Signing APK : keystore stocké dans GitHub Secrets

---

## Architecture MeshCore Companion (BLE ↔ LoRa)

### Flux réception d'un message LoRa
```
Firmware LoRa
  → PUSH_MSG_WAITING (0x83)
  → App appelle syncNextMessage() → CMD_SYNC_NEXT_MSG (10)
  → Firmware répond RESP_DIRECT_MSG_V3 (0x10) ou RESP_CHANNEL_MSG_V3 (0x11)
  → ble-gateway.ts : handleFrame() → parseDirectMsgV3() / parseChannelMsgV3()
  → deliverCompanionTextPacket() → this.messageHandler(packet)
  → BleProvider.onPacket wrapper → handleIncomingMeshCorePacket (MessagesProvider)
  → saveMessage() + setMessagesByConv() → UI
```

### Points critiques découverts
1. **`messageHandler` sur BleGatewayClient (singleton)** : doit être set avant que les messages arrivent.
   - Set via `ble.onPacket(handler)` dans MessagesProvider useEffect `[ble.connected, identity]`
   - Race condition : syncNextMessage() initial (handshake) tire AVANT que le handler soit enregistré
   - FIX : syncNextMessage() post-enregistrement avec délai 300ms

2. **`deliverCompanionTextPacket`** : chemin unique de livraison des messages texte Companion.
   - Firmware déchiffre lui-même → envoie en clair → flags: 0x00
   - `incomingMessageCallback` = chemin parallèle MORT (jamais utilisé par MessagesProvider)
   - `messageHandler` = chemin ACTIF → MessagesProvider

3. **`onPacket` dans BleProvider** : garde `if (clientRef.current)` → si null, handler silencieusement perdu.

### Formats de trames
- `RESP_DIRECT_MSG_V3` (0x10) : `[SNR:1][reserved:2][pubKeyPrefix:6][pathLen:1][txtType:1][timestamp:4LE][text...]`
- `RESP_CHANNEL_MSG_V3` (0x11) : `[SNR:1][reserved:2][channelIdx:1][pathLen:1][txtType:1][timestamp:4LE][text...]`
- `txtType == 2` (TXT_TYPE_SIGNED_PLAIN) : 4 bytes de signature prefix avant le texte (offset +4)

### Conversion nodeId
```
pubkeyPrefix (12 hex chars = 6 bytes) → padded 8 bytes (big-endian) → BigUint64
→ uint64ToNodeId() : hex 16 chars → slice(0,8) → "MESH-" + upper
Ex: "a1b2c3d4e5f6" → 0xa1b2c3d4e5f60000n → "MESH-A1B2C3D4"
```

---

## Architecture Nostr (DMs + Forums)

### Flux réception DMs Nostr
```
NostrClient.subscribeDMs() → kind:4 NIP-04 (rétrocompat)
NostrClient.subscribeDMsSealed() → kind:1059 NIP-17 sealed (protocole principal)
  → MessagingBus._dispatch(BusMessage)
  → MessagesProvider.messagingBus.subscribe() handler
  → saveMessage() + setMessagesByConv() → UI
```

### Bug critique corrigé (session)
- App envoyait avec `publishDMSealed()` (NIP-17 kind:1059)
- Mais `MessagingBus` n'écoutait que `subscribeDMs()` (NIP-04 kind:4)
- → Tous les DMs Nostr entre deux MeshPay étaient silencieusement perdus
- FIX : ajout de `subscribeDMsSealed()` dans `_startNostrListeners()`

### Forums (NIP-28)
- Canal = `forum:<name>` comme conversationId
- channelId déterministe via `deriveChannelId(channelName)`
- PSK (Pre-Shared Key) pour forums privés, chiffrés côté app avant envoi
- Auto-join forum "public" (canal 0) à la connexion BLE

### Identity
- Dérivée depuis mnemonic wallet (BIP39)
- `deriveMeshIdentity(mnemonic)` → nodeId MESH-XXXX + privkeyBytes + pubkeyHex
- Pubkey hex 66 chars (compressée 02/03) → 64 chars (x-only Nostr) = `slice(2)`

---

## Base de données SQLite

### Tables principales
- `messages` : id, conversationId, fromNodeId, fromPubkey, text, type, timestamp, isMine, status, transport, ...
- `conversations` : id, name, isForum, peerPubkey, lastMessage, lastMessageTime, unreadCount
- `pending_messages` : pour MessageRetryService (BLE retry queue) + `conversation_id`

### Règles importantes
- `saveMessage()` est async — TOUJOURS awaiter dans les handlers de réception
- Auto-cleanup messages > 24h (MESSAGE_RETENTION_HOURS = 24)
- Deduplication : Set `recentMsgIds` + MeshRouter (TTL 5 min)

---

## Services critiques

### BackgroundBleService (corrigé session)
- N'utilise PAS expo-background-task (incompatible SDK 54 APK)
- Utilise uniquement `AppState` + `setInterval` (15s)
- Traite jusqu'à 5 messages BLE pending par cycle

### MessageRetryService
- Queue les messages BLE échoués dans SQLite (pending_messages)
- Retry via BackgroundBleService
- `cancelAllForConversation()` → supprime par conversation_id

### MessagingBus (singleton)
- Abstraction transport Nostr uniquement (pas BLE)
- `setLocalIdentity()` doit être appelé pour démarrer les listeners
- Déduplication window intégrée
- `_startNostrListeners()` : NIP-04 + NIP-17 sealed (après fix)

---

## Radar (MeshRadar)

### Transport différenciation
- LoRa (GatewayPeer) → triangle orange `#F7931A`
- Nostr (subscribePresence) → cercle violet `#9B59D0`
- Les deux → losange vert `#00D68F`
- TTL peers : 10 min, cleanup toutes les 2 min

### RadarProvider
- Merge LoRa + Nostr par nodeId
- RSSI réel depuis GatewayPeer pour LoRa
- Hop count badge sur blips LoRa (> 1 hop)

---

## CI/CD

### Workflows GitHub Actions
- `ota-update.yml` : push sur main → `eas update --channel preview`
  - Déclenché si fichiers app/* ou services/* ou providers/* ou utils/* changent
  - EXPO_TOKEN requis dans GitHub Secrets
- `android-build.yml` : tag `apk-*` → build APK signé
  - Keystore + passwords dans GitHub Secrets
  - APK uploadé en artifact de release

### Historique builds importants
- `apk-v3.0.19` (fe75279) : fix crash expo-background-task ✅
- `apk-v3.0.20` (4a7c708) : fix réception messages (3 bugs) — en cours

### EXPO_TOKEN
- Doit être mis à jour dans GitHub Secrets si expiré
- Mettre à jour via GitHub API avec PyNaCl pour chiffrer le secret

---

## Pièges à éviter

1. **Ne jamais ajouter expo-background-task / expo-task-manager** : incompatible avec le build natif SDK 54 APK
2. **bun.lock est strict** : `bun add <package>` requis, pas d'édition manuelle de package.json
3. **saveMessage() est async** : toujours `await` dans les handlers BLE/Nostr
4. **NIP-17 ≠ NIP-04** : s'abonner aux DEUX pour rétrocompatibilité
5. **messageHandler race condition** : syncNextMessage() initial est trop tôt → prévoir un retry post-handler
6. **pubkeyHex 66 chars vs 64 chars** : Nostr x-only = slice(2) si commence par 02/03
