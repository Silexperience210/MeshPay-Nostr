<div align="center">

# 🥜🌐 MeshPay-Nostr 📶⚡

### Messagerie P2P Incensurable | Identité Bitcoin Proof | Wallet Cashu | LoRa Mesh | Marketplace Décentralisée

[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20iOS-blue.svg)](https://github.com/Silexperience210/MeshPay-Nostr)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Silexperience210/MeshPay-Nostr)](https://github.com/Silexperience210/MeshPay-Nostr/releases)
[![Cashu](https://img.shields.io/badge/Cashu-9.5%2F10-gold)](https://cashu.space)

[![Bitcoin](https://img.shields.io/badge/Bitcoin-Identity%20Proof-orange?logo=bitcoin)](https://github.com/Silexperience210/MeshPay-Nostr)
[![LoRa](https://img.shields.io/badge/LoRa-Uncensorable-brightgreen?logo=semtech)](https://lora-alliance.org/)
[![MeshCore](https://img.shields.io/badge/MeshCore-BLE%20V3-blueviolet)](https://github.com/meshcore-dev/MeshCore)
[![Nostr](https://img.shields.io/badge/Nostr-NIP--15%2F17%2F1985-purple)](https://nostr.com)

**MeshPay-Nostr** est la **première messagerie P2P incensurable** combinant **identité Bitcoin proof**, **wallet Cashu**, **marketplace décentralisée NIP-15** et **commerce local via LoRa Mesh**. Aucun serveur, aucune censure, fonctionne même sans internet.

[📦 Télécharger APK](https://github.com/Silexperience210/MeshPay-Nostr/releases/latest) • [📖 Documentation](#documentation) • [🚀 Roadmap](#roadmap)

</div>

---

## 🔥 Ce qui rend MeshPay-Nostr UNIQUE

### 🛡️ Messagerie Incensurable
- **Aucun serveur central** — Communication directe P2P
- **LoRa Mesh** — Fonctionne sans internet (5–20 km)
- **BLE Gateway** — Connexion directe appareil-à-appareil
- **Résistant à la censure** — Impossible à bloquer

### 🆔 Identité Bitcoin Proof
- **NodeId dérivé de votre wallet** — MESH-XXXX unique
- **Clés Bitcoin = Identité** — Pas de compte, pas de pseudo
- **Vérification cryptographique** — Impossible d'usurper
- **BIP-85 isolation** — Bitcoin / Nostr / MeshCore indépendants

### 🛒 Marketplace Décentralisée (NEW v3.0.7)
- **NIP-15** — Stalls (kind:30017) et produits (kind:30018) publiés sur Nostr
- **Commerce LoRa local** — Annonces ~60 bytes diffusées sur le mesh sans internet
- **Paiement intégré** — Cashu eCash, Lightning BOLT11, on-chain Bitcoin
- **Commandes chiffrées** — DMs NIP-17 Gift Wrap entre acheteur et vendeur
- **Réputation NIP-1985** — Avis 1–5 étoiles publiés on-chain, impossibles à falsifier
- **Notifications push** — Nouvelles commandes, paiements, avis en temps réel
- **Gestion stock** — Quantité fixe ou illimitée, zones de livraison personnalisées

### 💰 Wallet Cashu #1 (9.5/10)
- **Mint/Melt/Swap complet** — Tous les NUTs implémentés
- **Atomic swaps** — BTC↔Cashu trustless
- **P2PK tokens** — Verrouillables à une clé (NUT-11)

---

## ✨ Fonctionnalités Complètes

### 📡 Communication
- ✅ **DMs chiffrés E2E** — ECDH secp256k1 + AES-GCM-256 (transport mesh)
- ✅ **DMs Nostr NIP-44** — ChaCha20-Poly1305 + HKDF
- ✅ **Gift Wrap NIP-17** — Sender anonymisé, timestamp aléatoire ±2 jours
- ✅ **Forums publics** — Chiffrement déterministe par nom
- ✅ **Forums privés PSK** — Clé aléatoire 256 bits, partagée via DM chiffré
- ✅ **LoRa longue portée** — 868/915 MHz, 5–20 km
- ✅ **BLE proximité** — 10–100 m, sans infrastructure
- ✅ **Multi-hop routing** — Jusqu'à 10 sauts
- ✅ **Messages auto-destruct** — Effacement après 24 h

### 🛒 Marketplace (v3.0.7)
- ✅ **Onglet Shop dédié** — Browse / Ma boutique / Commandes
- ✅ **Publication Nostr NIP-15** — Stall + produits diffusés sur les relays
- ✅ **Broadcast LoRa local** — `SHOP:{id,name,price,stock,pubkey}` compact
- ✅ **TTL LoRa 30 min** — Produits expirés retirés automatiquement
- ✅ **Checkout 3 étapes** — Livraison → Paiement → Confirmation
- ✅ **Zones de livraison** — Coût variable par région (France, Europe, Monde)
- ✅ **Flux vendeur** — Envoi info paiement (BOLT11 / BTC / Cashu token)
- ✅ **Flux acheteur** — Copie paiement, suivi statut commande
- ✅ **Avis post-livraison** — ReviewModal 5 étoiles + commentaire 500 chars
- ✅ **Réputation produit/vendeur** — Moyenne étoiles affichée sur ProductCard
- ✅ **Notifications push** — Canaux Android `shop_orders` / `shop_reviews`
- ✅ **Images produit** — Alerte si URI locale (non accessible publiquement)

### 🆔 Identité & Sécurité
- ✅ **NodeId unique** — Dérivé cryptographiquement du wallet (SHA256 pubkey)
- ✅ **BIP-85 identity isolation** — Seeds Bitcoin/Nostr/MeshCore indépendants
- ✅ **Anti-usurpation** — Vérification signature obligatoire
- ✅ **Display name** — Optionnel, changeable
- ✅ **Status en ligne** — Présence temps réel
- ✅ **Radar de pairs** — Carte GPS des utilisateurs proches

### 💰 Wallet Cashu Avancé
- ✅ **Mint/Melt/Swap** — NUTs 03, 04, 05
- ✅ **P2PK** — Tokens verrouillables (NUT-11)
- ✅ **DLEQ proofs** — Vérification cryptographique (NUT-12)
- ✅ **QR animés** — Gros tokens en plusieurs parties (NUT-16)
- ✅ **Atomic swaps** — Échange BTC↔Cashu trustless
- ✅ **Backup/Restore** — Export JSON

### 📡 BLE MeshCore V3
- ✅ **Nordic UART (NUS)** — Service `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
- ✅ **Battery** — `RESP_BATT_STORAGE` uint16 millivolts (fix v3.0.7)
- ✅ **Stats parsées** — CORE / RADIO / PACKETS layouts corrects (fix v3.0.7)
- ✅ **Settings LoRa** — Fréquence / SF / TX Power liés aux vraies valeurs BLE (fix v3.0.7)

---

## 🏆 MeshPay-Nostr vs Concurrence

| Feature | MeshPay-Nostr | Signal | Telegram | OpenBazaar |
|---------|--------------|--------|----------|------------|
| **Sans serveur** | ✅ P2P | ❌ Centralisé | ❌ Centralisé | ⚠️ |
| **Sans internet** | ✅ LoRa | ❌ | ❌ | ❌ |
| **Identité Bitcoin** | ✅ | ❌ | ❌ | ❌ |
| **Wallet intégré** | ✅ Cashu+LN | ❌ | ❌ | ⚠️ |
| **Marketplace P2P** | ✅ NIP-15 | ❌ | ❌ | ✅ |
| **Commerce hors-ligne** | ✅ LoRa | ❌ | ❌ | ❌ |
| **Réputation on-chain** | ✅ NIP-1985 | ❌ | ❌ | ⚠️ |
| **Censure-résistant** | ✅ | ⚠️ | ❌ | ⚠️ |

---

## ⚡ État Actuel (Mars 2026)

### ✅ v3.0.7 — MARKETPLACE + BLE HARDENED

| Module | Status |
|--------|--------|
| Messagerie P2P (LoRa/BLE) | ✅ 100% |
| Chiffrement NIP-44 (ChaCha20-Poly1305) | ✅ 100% |
| Forums privés PSK 256 bits | ✅ 100% |
| Identité BIP-85 (Bitcoin/Nostr/Mesh) | ✅ 100% |
| Wallet Cashu complet | ✅ 100% |
| Gift Wrap NIP-17 | ✅ 100% |
| GPS Radar | ✅ 100% |
| Multi-hop routing | ✅ 100% |
| **Marketplace NIP-15 (Shop tab)** | ✅ **NEW** |
| **Commerce LoRa local (SHOP: prefix)** | ✅ **NEW** |
| **Checkout Cashu/LN/onchain** | ✅ **NEW** |
| **Réputation NIP-1985** | ✅ **NEW** |
| **Notifications push (shop_orders/reviews)** | ✅ **NEW** |
| **Fix BLE battery (uint16 mv)** | ✅ **Fixed** |
| **Fix parseStats CORE/RADIO/PACKETS** | ✅ **Fixed** |
| **Fix LoRa Settings (fréq/SF/TX réels)** | ✅ **Fixed** |

---

## 🔒 Sécurité — Audit Cypherpunk

### Corrections appliquées (v2.7)

| Composant | Correction |
|-----------|------------|
| `nostr-client.ts` | **NIP-44 v2** — ChaCha20-Poly1305 + HKDF + padding |
| `encryption.ts` | `generateForumKey()` — PSK 256 bits aléatoire |
| `identity.ts` | **BIP-85** — seeds enfants isolés par domaine |
| `cashu.ts` | Rejection sampling + `crypto.getRandomValues` + HTTPS forcé |
| `bitcoin-tx.ts` | Clés privées effacées (`fill(0)`) dans `finally` |
| `BitcoinProvider.ts` | Mutex `isSendingRef` anti-TOCTOU |
| `mempool.ts` | Sanity check frais — plafond 1 000 sat/vB |

### TODO — Améliorations futures

- **[ ] Forward secrecy DMs** — Ratchet ECDH éphémère par message
- **[ ] BigInt non-zéroable** (`cashu.ts`) — Refactoriser blinding factor en `Uint8Array`
- **[ ] Mnémonique en React state** — Déverrouillage biométrique natif
- **[ ] Mode strict DLEQ** — Rejeter proofs sans DLEQ (NUT-12)
- **[ ] Passphrase BIP39** — Support 25e mot à l'import/génération
- **[ ] Relay Tor/i2p** — Masquer IPs et métadonnées de connexion
- **[ ] Timestamp noise** — Quantifier `created_at` à la minute

---

## 📦 Installation

```bash
# Télécharger la dernière release
wget https://github.com/Silexperience210/MeshPay-Nostr/releases/latest/download/MeshPay-Nostr.apk

# Installer via ADB
adb install MeshPay-Nostr.apk
```

---

## 🚀 Utilisation Rapide

### 1. Créer son identité
```
Settings → Wallet → Generate 12 Words
```
Votre NodeId MESH-XXXX est automatiquement créé.

### 2. Rejoindre un forum
```
Messages → + → Discover → Sélectionner un forum
```

### 3. Ouvrir la marketplace
```
Onglet Shop → Browse produits Nostr & LoRa locaux
```

### 4. Vendre un produit
```
Shop → Ma boutique → + Produit → Publier sur Nostr ou Broadcaster en LoRa
```

### 5. Acheter et payer
```
Shop → Sélectionner produit → Checkout → Cashu / Lightning / Bitcoin
```

### 6. Recevoir/envoyer Cashu
```
Messages → Attacher token → ou Wallet → Melt
```

---

## 💝 Soutenir MeshPay

**Cashu:** `silexperience@minibits.cash`

Vos dons financent le développement open-source.

---

## 🏛️ Architecture - Hermès Engine v2.0

MeshPay-Nostr utilise désormais **Hermès Engine**, une architecture event-sourced qui remplace progressivement les React Contexts traditionnels.

### Pourquoi Hermès ?

| Avantages | Description |
|-----------|-------------|
| **Performance** | Plus de re-renders inutiles des Context Providers |
| **Testabilité** | Event-sourced = tests déterministes |
| **Débogage** | Time-travel debugging avec EventStore |
| **Extensibilité** | Ajouter un transport = 1 adapter |

### Migration en cours

- **v3.3.0** (actuel): Providers legacy marqués `@deprecated`
- **v3.4.0**: Warnings dans la console en dev
- **v4.0.0**: Suppression des providers legacy

### Utilisation rapide

```tsx
import { useNostrHermes, useMessages, useGateway } from '@/engine/hooks';

function MyComponent() {
  // Nostr
  const { isConnected, publicKey, publishDM } = useNostrHermes();
  
  // Messages
  const { conversations, sendDM } = useMessages();
  
  // Gateway
  const { status, startGateway, stats } = useGateway();
  
  // ...
}
```

📖 **[Guide de migration complet](./MIGRATION_GUIDE.md)**

---

## 📜 Licence

MIT License — Voir [LICENSE](./LICENSE)

---

<div align="center">

**Fait avec ❤️ par la communauté MeshPay-Nostr**

[⭐ Star ce repo](https://github.com/Silexperience210/MeshPay-Nostr) • [🐛 Signaler un bug](https://github.com/Silexperience210/MeshPay-Nostr/issues)

</div>
