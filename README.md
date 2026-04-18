<div align="center">

# MeshPay-Nostr

**Mobile messaging + Bitcoin wallet — over Nostr (online) and LoRa mesh (offline).**

[![Platform](https://img.shields.io/badge/platform-Android-3DDC84?logo=android&logoColor=white)](https://github.com/Silexperience210/MeshPay-Nostr/releases)
[![Latest Release](https://img.shields.io/github/v/release/Silexperience210/MeshPay-Nostr?include_prereleases&sort=semver)](https://github.com/Silexperience210/MeshPay-Nostr/releases/latest)
[![Tests](https://img.shields.io/badge/tests-701%20%2F%20701-brightgreen)](#tests)
[![Status](https://img.shields.io/badge/status-beta-orange)](#limitations)
[![License](https://img.shields.io/badge/license-all%20rights%20reserved-lightgrey)](#license)

[![React Native](https://img.shields.io/badge/React%20Native-0.81-61DAFB?logo=react&logoColor=white)](https://reactnative.dev)
[![Expo](https://img.shields.io/badge/Expo%20SDK-54-000020?logo=expo&logoColor=white)](https://expo.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Zustand](https://img.shields.io/badge/state-Zustand%205-443e38)](https://github.com/pmndrs/zustand)

[![Nostr](https://img.shields.io/badge/Nostr-NIP--17%20%2F%20NIP--44%20%2F%20NIP--28-purple)](https://github.com/nostr-protocol/nips)
[![Bitcoin](https://img.shields.io/badge/Bitcoin-BIP39%20%2F%20BIP84%20%2F%20BIP85-F7931A?logo=bitcoin&logoColor=white)](https://github.com/bitcoin/bips)
[![Cashu](https://img.shields.io/badge/Cashu-NUT--03%2F04%2F05%2F11%2F12-yellow)](https://cashu.space)
[![MeshCore](https://img.shields.io/badge/MeshCore-Companion%20BLE-blueviolet)](https://github.com/meshcore-dev/MeshCore)

[Releases](https://github.com/Silexperience210/MeshPay-Nostr/releases) ·
[Issues](https://github.com/Silexperience210/MeshPay-Nostr/issues) ·
[Architecture](#architecture) ·
[Security](#security) ·
[Limitations](#limitations)

</div>

---

Built with React Native and Expo. Android-first.

> **Status:** beta. The core messaging, wallet, and Nostr/LoRa transports work.
> The marketplace, NFC backup, and several BLE companion features are still
> hardening — see [Limitations](#limitations) below.

---

## What it actually does

### Messaging
- **Nostr DMs** — NIP-44 (ChaCha20-Poly1305 + HKDF) and NIP-17 sealed Gift Wrap (kind:1059)
- **Nostr public channels** — NIP-28 (kind:40/41/42) with deterministic channel IDs from a forum name
- **LoRa direct + channel messages** — over a MeshCore BLE companion device (ESP32 with MeshCore firmware)
- **Auto-bridge** — incoming LoRa traffic can be relayed to Nostr (and vice-versa) when both transports are connected

### Wallet
- **BIP39 mnemonic** (12 or 24 words), generated locally, stored in `expo-secure-store`
- **BIP84 / m/84'/0'/0'** native segwit (`bc1...`) — **mainnet only** today
- **Mempool.space** for balance / UTXOs / fee estimates / broadcast
- **Cashu eCash** — mint / melt / swap (NUT-03/04/05), P2PK locking (NUT-11),
  DLEQ verification (NUT-12), encrypted backup
- **Bitcoin tx broadcast fallback over Nostr** — if the mempool API is
  unreachable, a signed tx can be relayed via a Nostr gateway peer

### Identity
- **BIP-85 isolation** — the BIP39 seed derives independent child seeds for
  Bitcoin / Nostr / MeshCore so a leak in one domain doesn't expose the others
  (see `utils/identity.ts`)
- The Nostr public key (npub) is your identity — no account, no signup

### App surfaces
- 5 tabs: **Messages**, **Mesh**, **Wallet**, **Shop**, **Settings**
- 3 locales: English, French, Spanish (`locales/`)
- NFC backup of the encrypted wallet (NDEF, with NdefFormatable fallback)
- QR scanner for seed restore + Bitcoin payment URIs

---

## Tech stack

| Area | Choice |
|------|--------|
| Framework | Expo SDK 54, React Native 0.81, React 19 |
| Router | `expo-router` v6 |
| State | Zustand 5 (wallet, settings, UI) + a few legacy Context providers |
| Crypto | `@noble/curves`, `@noble/ciphers`, `@noble/hashes`, `@scure/bip32`, `@scure/bip39`, `secp256k1`, `bitcoinjs-lib` |
| Nostr | `nostr-tools` 2.x |
| BLE | `react-native-ble-manager` + `react-native-ble-plx` (MeshCore Companion protocol) |
| USB serial | `react-native-usb-serialport-for-android` (alternative to BLE for desktop testing) |
| Tests | Jest + `jest-expo` (701 tests across 24 suites at last commit) |
| Build / OTA | EAS Build + `expo-updates` (OTA disabled in practice — release via APK tags) |

---

## Hardware (optional but required for offline mode)

To use the LoRa mesh, you need a **MeshCore-compatible BLE companion device**
— typically an ESP32 + SX1262 board flashed with the [MeshCore firmware](https://github.com/meshcore-dev/MeshCore).

The app speaks the MeshCore Companion BLE protocol (Nordic UART service,
`6E400001-…`). Without a device, only the Nostr (online) transport is
available.

---

## Install (end user)

The Android APK is published as GitHub releases.

```bash
# Latest release
adb install MeshPay-Nostr.apk
```

Releases live at `https://github.com/Silexperience210/MeshPay-Nostr/releases`.

> iOS is configured in `app.json` but is not actively built or tested.
> There is no `ios/` native directory in the repo.

---

## Develop

```bash
bun install
bun start            # Expo dev server
bun run android      # build + install debug APK on a connected device
bun test             # jest
npx tsc --noEmit     # typecheck
```

The CI workflow `.github/workflows/android-build.yml` builds a release APK
when a tag matching `apk-*` is pushed. There is no auto-deploy on push.

---

## Architecture

### Hermès Engine

`engine/HermesEngine.ts` is an event-sourced bus. Two protocol adapters plug
into it:

- `engine/adapters/NostrAdapter.ts` — wraps `nostr-tools` and emits
  `DM_RECEIVED`, `CHANNEL_MSG_RECEIVED`, `BRIDGE_*` events
- `engine/adapters/LoRaAdapter.ts` — wraps the MeshCore BLE client and does
  the same for LoRa traffic

A `GatewayManager` (`engine/gateway/`) handles auto-bridging between the two
when both adapters are connected.

A `UnifiedIdentityManager` (`engine/identity/`) creates the BIP-85 derived
seeds when the wallet is first generated.

The legacy Context providers under `providers/` are still in use for
some screens — migration to Hermès is gradual.

### Stores (Zustand)

- `stores/walletStore.ts` — mnemonic + derived addresses, persisted in
  SecureStore. Hydration is async; consumers should wait for `_hasHydrated`.
- `stores/settingsStore.ts` — connection mode, language, mempool URL,
  Cashu mint, Nostr relay list. Persisted in AsyncStorage.

### Where the code lives

```
app/            Expo Router screens (tabs, onboarding, identity-setup)
components/     Modals + reusable UI
engine/         Hermès bus, adapters, identity, gateway, services
providers/      Legacy React Context wrappers (some still in use)
services/       Background BLE, ACK, chunking, retry, migration
stores/         Zustand stores (wallet, settings, UI)
utils/          Crypto, BIP39, NIP-04/17/44, Cashu, mempool, MeshCore protocol
locales/        i18n (en/fr/es)
```

---

## Security

What is in place today:

- **Mnemonic at rest** in `expo-secure-store` (Android Keystore / iOS Keychain)
- **NIP-44 v2** (ChaCha20-Poly1305 + HKDF + length padding) for Nostr DMs
- **NIP-17 Gift Wrap** for sealed-sender DMs (sender pubkey + timestamp hidden)
- **BIP-85 domain isolation** between Bitcoin / Nostr / MeshCore identities
- **Forum PSK** — 256-bit random key for private LoRa channels, shared via
  encrypted DM
- **Mnemonic validation before signing** — `validateMnemonic()` is called
  before any Bitcoin transaction is signed (prevents fund loss on a corrupted
  seed)
- **wss:// only** for custom Nostr relays (rejects plaintext `ws://`)
- **Fee sanity cap** at 1000 sat/vB to block fee-grief attacks
- **Send mutex** (`isSendingRef`) to prevent two concurrent transactions
  spending the same UTXOs

What is **not** done yet (PRs welcome):

- No forward secrecy on DMs (no per-message ECDH ratchet)
- No biometric unlock — the mnemonic is decrypted as soon as the app starts
- No Tor / i2p relay for IP metadata
- No timestamp quantization on outgoing Nostr events
- Strict-DLEQ mode for Cashu is not enforced (proofs without DLEQ are accepted)

---

## Limitations

- **Mainnet only.** A `bitcoinNetwork` setting exists in the store but the
  derivation paths and address generation are hardcoded to mainnet. The UI
  toggle for Testnet was removed in the latest audit because it had no effect.
- **OTA updates are configured but unreliable.** Ship by pushing an `apk-*`
  tag and distributing the APK from the GitHub release.
- **Marketplace (Shop tab) is functional but young.** It publishes NIP-15
  stalls (kind:30017) and products (kind:30018), accepts Cashu / Lightning /
  on-chain checkout, and supports NIP-1985 reviews — but none of this has
  been load-tested with real merchants.
- **Multi-hop LoRa range depends entirely on the hardware.** The "5–20 km"
  number you see in older docs assumes line-of-sight + high-gain antennas.
  In practice it's whatever your ESP32 board + antenna can reach.
- **No iOS build.** The app.json declares iOS keys but `ios/` doesn't exist
  in the repo and there is no iOS workflow in CI.
- **The `nostrClient.subscribeChannel('*', ...)` handler in NostrAdapter
  is broad** — every channel message hits the engine. Filter by channel ID
  before broadcasting to UI for production use.

---

## Tests

```bash
bun test
```

Last verified: **701 / 701 passing across 24 suites** (commit `2b1dd2a`).

Coverage is concentrated in:

- `engine/__tests__/unit/` — Hermès engine, adapters, EventStore,
  deduplication, gateway, message service, unified identity
- `engine/__tests__/integration/` — bridge LoRa↔Nostr, double-write
- `utils/__tests__/` — BIP39 / wallet / Bitcoin tx, NIP-17, Nostr client,
  channels, presence, Cashu, tx-relay, messaging-bus

UI components and Expo Router screens are not covered by Jest — manual
testing required.

---

## Donations

If this is useful to you:

- **Cashu (Lightning):** `silexperience@minibits.cash`

---

## License

No `LICENSE` file is present in the repo at the time of writing. Until one is
added, treat this code as **all rights reserved** by the author. If you intend
to fork, distribute, or build commercially on top of it, open an issue first.

---

## Contributing

Bug reports and PRs are welcome at
[github.com/Silexperience210/MeshPay-Nostr/issues](https://github.com/Silexperience210/MeshPay-Nostr/issues).

When opening a PR, please run before pushing:

```bash
npx tsc --noEmit
bun test
```
