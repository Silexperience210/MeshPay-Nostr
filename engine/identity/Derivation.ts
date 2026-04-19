/**
 * Dérivation cryptographique unifiée pour Bitcoin, Nostr et MeshCore
 * 
 * Toutes les identités sont dérivées depuis une seule seed BIP39 mnemonic.
 * 
 * Chemins de dérivation:
 * - m/84'/0'/0'        → Bitcoin (BIP84 - Native Segwit)
 * - m/44'/1237'/0'/0/0 → Nostr (NIP-06)
 * - m/44'/0'/0'/0/0    → MeshCore (Custom pour MeshPay)
 */

import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { mnemonicToSeed } from '@/utils/bitcoin';
import { secp256k1 } from '@noble/curves/secp256k1';

// ─── Chemins de dérivation ───────────────────────────────────────────────────

export const DERIVATION_PATHS = {
  /** BIP84 - Bitcoin Native Segwit */
  bitcoin: "m/84'/0'/0'",
  /** NIP-06 - Nostr key derivation */
  nostr: "m/44'/1237'/0'/0/0",
  /** Custom - MeshCore identity */
  meshcore: "m/44'/0'/0'/0/0",
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BitcoinIdentity {
  /** Extended public key pour dérivation d'adresses */
  xpub: string;
  /** Empreinte du master key (hex 8 caractères) */
  fingerprint: string;
  /** Première adresse de réception (bc1...) */
  firstAddress: string;
}

export interface NostrIdentity {
  /** Clé privée 32 bytes hex */
  privkey: string;
  /** Clé publique 32 bytes hex (x-only) */
  pubkey: string;
  /** Clé publique encodée en npub */
  npub: string;
}

export interface MeshCoreIdentity {
  /** Clé privée 32 bytes hex */
  privkey: string;
  /** Clé publique 33 bytes hex (compressée) */
  pubkey: string;
  /** NodeId formaté MESH-XXXX */
  nodeId: string;
}

export interface UnifiedIdentity {
  bitcoin: BitcoinIdentity;
  nostr: NostrIdentity;
  meshcore: MeshCoreIdentity;
  metadata: {
    createdAt: number;
    derivationVersion: string;
  };
}

// ─── Dérivation principale ────────────────────────────────────────────────────

/**
 * Dérive toutes les identités depuis une seed mnemonic BIP39.
 * 
 * @param mnemonic - Phrase mnémonique BIP39 (12 ou 24 mots)
 * @returns Identités unifiées pour Bitcoin, Nostr et MeshCore
 */
export function deriveUnifiedIdentity(mnemonic: string): UnifiedIdentity {
  const seed = mnemonicToSeed(mnemonic);
  const masterKey = HDKey.fromMasterSeed(seed);

  // Dériver les trois identités
  const bitcoin = deriveBitcoinIdentity(masterKey);
  const nostr = deriveNostrIdentity(masterKey);
  const meshcore = deriveMeshCoreIdentity(masterKey);

  return {
    bitcoin,
    nostr,
    meshcore,
    metadata: {
      createdAt: Date.now(),
      derivationVersion: '1.0',
    },
  };
}

// ─── Dérivation Bitcoin (BIP84) ───────────────────────────────────────────────

/**
 * Dérive l'identité Bitcoin selon BIP84 (Native Segwit).
 */
function deriveBitcoinIdentity(masterKey: HDKey): BitcoinIdentity {
  const bitcoinKey = masterKey.derive(DERIVATION_PATHS.bitcoin);
  
  if (!bitcoinKey.publicKey) {
    throw new Error('[Derivation] Failed to derive Bitcoin public key');
  }

  // Première adresse de réception: m/84'/0'/0'/0/0
  const firstReceiveKey = bitcoinKey.deriveChild(0)?.deriveChild(0);
  if (!firstReceiveKey?.publicKey) {
    throw new Error('[Derivation] Failed to derive first receive address');
  }

  return {
    xpub: bitcoinKey.publicExtendedKey,
    fingerprint: bitcoinKey.fingerprint?.toString(16).padStart(8, '0').toUpperCase() || '',
    firstAddress: deriveSegwitAddress(firstReceiveKey.publicKey),
  };
}

/**
 * Dérive une adresse Segwit native (bech32) depuis une clé publique.
 * 
 * @param pubkey - Clé publique 33 bytes (compressée)
 * @returns Adresse Bitcoin bc1...
 */
function deriveSegwitAddress(pubkey: Uint8Array): string {
  // Hash160 du SHA256 de la clé publique
  const hash = ripemd160(sha256(pubkey));
  
  // Convertir en bech32 (v0 witness program)
  // Pour mainnet: hrp = 'bc', testnet: hrp = 'tb'
  return encodeBech32('bc', 0, hash);
}

// ─── Dérivation Nostr (NIP-06) ────────────────────────────────────────────────

/**
 * Dérive l'identité Nostr selon NIP-06.
 */
function deriveNostrIdentity(masterKey: HDKey): NostrIdentity {
  const nostrKey = masterKey.derive(DERIVATION_PATHS.nostr);

  if (!nostrKey.privateKey) {
    throw new Error('[Derivation] Failed to derive Nostr private key');
  }

  const privkey = bytesToHex(nostrKey.privateKey);
  const pubkey = getPublicKey(privkey);

  return {
    privkey,
    pubkey,
    npub: encodeNpub(pubkey),
  };
}

/**
 * Calcule la clé publique Nostr (x-only) depuis une clé privée.
 * 
 * Nostr utilise des clés publiques x-only (32 bytes) sans préfixe 02/03.
 */
function getPublicKey(privateKey: string): string {
  const privkeyBytes = hexToBytes(privateKey);
  const pubkey = secp256k1.getPublicKey(privkeyBytes, true); // 33 bytes compressé
  // Retourner sans le préfixe (x-only)
  return bytesToHex(pubkey.slice(1));
}

/**
 * Encode une clé publique Nostr en format npub (bech32).
 */
function encodeNpub(pubkey: string): string {
  const data = hexToBytes(pubkey);
  return encodeBech32('npub', undefined, data);
}

// ─── Dérivation MeshCore ──────────────────────────────────────────────────────

/**
 * Dérive l'identité MeshCore (dérivation custom).
 */
function deriveMeshCoreIdentity(masterKey: HDKey): MeshCoreIdentity {
  const meshcoreKey = masterKey.derive(DERIVATION_PATHS.meshcore);

  if (!meshcoreKey.privateKey || !meshcoreKey.publicKey) {
    throw new Error('[Derivation] Failed to derive MeshCore keys');
  }

  const privkey = bytesToHex(meshcoreKey.privateKey);
  const pubkey = secp256k1.getPublicKey(meshcoreKey.privateKey, true);

  return {
    privkey,
    pubkey: bytesToHex(pubkey),
    nodeId: deriveMeshNodeId(pubkey),
  };
}

/**
 * Dérive le NodeId MeshCore depuis une clé publique.
 * 
 * Format: MESH-XXXX où XXXX sont les 4 premiers caractères du hash160
 * de la clé publique.
 */
function deriveMeshNodeId(pubkey: Uint8Array): string {
  const hash = ripemd160(sha256(pubkey));
  const hashHex = bytesToHex(hash);
  return `MESH-${hashHex.slice(0, 4).toUpperCase()}`;
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────

/**
 * Encode des données en bech32.
 * Implémentation simplifiée pour bc1... et npub1...
 */
function encodeBech32(hrp: string, witnessVersion: number | undefined, data: Uint8Array): string {
  // Convertir les bytes en bits 5 par 5
  const bits5 = convertBits(data, 8, 5, true);
  
  // Ajouter le witness version si présent (pour Segwit)
  const payload = witnessVersion !== undefined
    ? new Uint8Array([witnessVersion, ...bits5])
    : new Uint8Array(bits5);

  // Calculer le checksum
  const checksum = createChecksum(hrp, payload);
  
  // Combiner payload et checksum
  const combined = new Uint8Array(payload.length + checksum.length);
  combined.set(payload);
  combined.set(checksum, payload.length);

  // Convertir en caractères bech32
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  let result = hrp + '1';
  for (const byte of combined) {
    result += CHARSET[byte];
  }
  
  return result;
}

/**
 * Convertit des bits d'une base à une autre.
 */
function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << toBits) - 1;
  const maxAcc = (1 << (fromBits + toBits - 1)) - 1;

  for (const value of data) {
    acc = ((acc << fromBits) | value) & maxAcc;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxv);
    }
  }

  return result;
}

/**
 * Crée le checksum bech32 pour un HRP et des données.
 */
function createChecksum(hrp: string, data: Uint8Array): Uint8Array {
  const values = hrpExpand(hrp).concat(Array.from(data));
  const polymod = bech32Polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ 1;
  const checksum = new Uint8Array(6);
  for (let i = 0; i < 6; i++) {
    checksum[i] = (polymod >> (5 * (5 - i))) & 31;
  }
  return checksum;
}

/**
 * Étend le HRP pour le calcul du checksum.
 */
function hrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (const c of hrp) {
    result.push(c.charCodeAt(0) >> 5);
  }
  result.push(0);
  for (const c of hrp) {
    result.push(c.charCodeAt(0) & 31);
  }
  return result;
}

/**
 * Calcule le polymod bech32.
 */
function bech32Polymod(values: number[]): number {
  const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      chk ^= ((b >> i) & 1) ? GENERATORS[i] : 0;
    }
  }
  return chk;
}

/**
 * Convertit une chaîne hexadécimale en Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ─── Export utilitaires ───────────────────────────────────────────────────────

export { hexToBytes, getPublicKey };
