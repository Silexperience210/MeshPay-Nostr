import * as bip39 from '@scure/bip39';
// @ts-ignore - subpath exports use .js extension
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
// @ts-ignore - subpath exports use .js extension
import { sha256 } from '@noble/hashes/sha2.js';
// @ts-ignore - subpath exports use .js extension
import { ripemd160 } from '@noble/hashes/legacy.js';
// @ts-ignore - subpath exports use .js extension
import { bytesToHex } from '@noble/hashes/utils.js';

const BIP44_BTC_PATH = "m/84'/0'/0'";

// ─── Constantes de validation ───────────────────────────────────────────────
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export interface DerivedWalletInfo {
  xpub: string;
  firstReceiveAddress: string;
  fingerprint: string;
}

export function generateMnemonic(strength: 12 | 24 = 12): string {
  // Vérifier que crypto.getRandomValues est disponible
  const hasCrypto = typeof globalThis !== 'undefined' && 
                    typeof (globalThis as any).crypto === 'object' &&
                    typeof (globalThis as any).crypto.getRandomValues === 'function';
  if (!hasCrypto) {
    console.error('[Bitcoin] crypto.getRandomValues not available!');
    throw new Error('crypto.getRandomValues must be defined. Polyfill not loaded correctly.');
  }
  
  const bits = strength === 12 ? 128 : 256;
  try {
    const mnemonic = bip39.generateMnemonic(wordlist, bits);
    console.log('[Bitcoin] Generated new mnemonic with', strength, 'words');
    return mnemonic;
  } catch (err: any) {
    console.error('[Bitcoin] Failed to generate mnemonic:', err);
    throw new Error(`Failed to generate mnemonic: ${err.message}`);
  }
}

export function validateMnemonic(mnemonic: string): boolean {
  const valid = bip39.validateMnemonic(mnemonic, wordlist);
  console.log('[Bitcoin] Mnemonic validation:', valid);
  return valid;
}

export function mnemonicToSeed(mnemonic: string, passphrase?: string): Uint8Array {
  console.log('[Bitcoin] Deriving seed from mnemonic...');
  return bip39.mnemonicToSeedSync(mnemonic, passphrase);
}

export function entropyToMnemonic(entropy: Uint8Array): string {
  return bip39.entropyToMnemonic(entropy, wordlist);
}

export { wordlist };

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/**
 * Décode une chaîne base58check et vérifie le checksum.
 * @returns Le payload décodé ou null si invalide
 */
function base58checkDecode(str: string): Uint8Array | null {
  try {
    // Vérifier que tous les caractères sont valides
    for (const char of str) {
      if (!BASE58_ALPHABET.includes(char)) {
        return null;
      }
    }

    // Compter les zéros de tête
    let leadingZeros = 0;
    for (const char of str) {
      if (char === '1') leadingZeros++;
      else break;
    }

    // Convertir base58 en nombre
    let num = 0n;
    for (const char of str) {
      const charIndex = BASE58_ALPHABET.indexOf(char);
      if (charIndex === -1) return null;
      num = num * 58n + BigInt(charIndex);
    }

    // Convertir en bytes
    const hex = num.toString(16).padStart(2, '0');
    const bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }

    // Ajouter les zéros de tête
    const result = new Uint8Array(leadingZeros + bytes.length);
    result.fill(0, 0, leadingZeros);
    result.set(bytes, leadingZeros);

    // Vérifier la taille minimum (version + hash + checksum)
    if (result.length < 25) return null;

    // Séparer payload et checksum
    const payload = result.slice(0, -4);
    const checksum = result.slice(-4);

    // Vérifier le checksum
    const computedChecksum = sha256(sha256(payload)).slice(0, 4);
    for (let i = 0; i < 4; i++) {
      if (checksum[i] !== computedChecksum[i]) {
        return null; // Checksum invalide
      }
    }

    return payload;
  } catch {
    return null;
  }
}

function base58check(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const data = new Uint8Array(payload.length + 4);
  data.set(payload);
  data.set(checksum, payload.length);

  let num = BigInt('0x' + bytesToHex(data));
  let result = '';
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    result = BASE58_ALPHABET[Number(remainder)] + result;
  }

  for (const byte of payload) {
    if (byte === 0) {
      result = '1' + result;
    } else {
      break;
    }
  }

  return result;
}

// ─── Validation Bech32 ─────────────────────────────────────────────────────

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) {
        chk ^= GEN[i];
      }
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) >> 5);
  }
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) {
    ret.push(hrp.charCodeAt(i) & 31);
  }
  return ret;
}

/**
 * Vérifie le checksum Bech32 d'une adresse.
 * @returns true si le checksum est valide
 */
function verifyBech32Checksum(hrp: string, data: number[]): boolean {
  const polymod = bech32Polymod(bech32HrpExpand(hrp).concat(data));
  return polymod === 1;
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const polymod = bech32Polymod(values) ^ 1;
  const ret: number[] = [];
  for (let i = 0; i < 6; i++) {
    ret.push((polymod >> (5 * (5 - i))) & 31);
  }
  return ret;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  }
  return ret;
}

function encodeBech32(hrp: string, witnessVersion: number, witnessProgram: Uint8Array): string {
  const fiveBitData = convertBits(witnessProgram, 8, 5, true);
  const data = [witnessVersion, ...fiveBitData];
  const checksum = bech32CreateChecksum(hrp, data);
  let result = hrp + '1';
  for (const d of data.concat(checksum)) {
    result += BECH32_CHARSET[d];
  }
  return result;
}

/**
 * Décode et valide une adresse Bech32/Bech32m.
 * @returns Les composants de l'adresse ou null si invalide
 */
function decodeBech32(address: string): { hrp: string; version: number; program: Uint8Array } | null {
  // Vérifier la casse (Bech32 doit être tout en minuscules ou tout en majuscules)
  const hasLower = /[a-z]/.test(address);
  const hasUpper = /[A-Z]/.test(address);
  if (hasLower && hasUpper) return null; // Casse mixte invalide

  const addr = address.toLowerCase();

  // Trouver le séparateur '1'
  const sepIndex = addr.lastIndexOf('1');
  if (sepIndex < 1 || sepIndex + 7 > addr.length) return null;

  const hrp = addr.slice(0, sepIndex);
  const dataPart = addr.slice(sepIndex + 1);

  // Vérifier que le HRP est valide (bc pour mainnet, tb pour testnet)
  if (hrp !== 'bc' && hrp !== 'tb') return null;

  // Décoder les caractères
  const data: number[] = [];
  for (const char of dataPart) {
    const index = BECH32_CHARSET.indexOf(char);
    if (index === -1) return null;
    data.push(index);
  }

  // Vérifier le checksum
  if (!verifyBech32Checksum(hrp, data)) return null;

  // Extraire la version et le programme witness
  const version = data[0];
  if (version > 16) return null;

  const fiveBitProgram = data.slice(1, -6); // Exclure le checksum
  const program = convertBits(new Uint8Array(fiveBitProgram), 5, 8, false);

  // Vérifier la taille du programme witness
  if (program.length < 2 || program.length > 40) return null;

  // Vérifier la taille pour v0 (P2WPKH doit faire 20 bytes, P2WSH doit faire 32 bytes)
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;

  return { hrp, version, program: new Uint8Array(program) };
}

export function pubkeyToSegwitAddress(pubkey: Uint8Array, mainnet: boolean = true): string {
  const h160 = hash160(pubkey);
  const hrp = mainnet ? 'bc' : 'tb';
  return encodeBech32(hrp, 0, h160);
}

export function pubkeyToLegacyAddress(pubkey: Uint8Array, mainnet: boolean = true): string {
  const h160 = hash160(pubkey);
  const prefix = mainnet ? 0x00 : 0x6f;
  const payload = new Uint8Array(1 + h160.length);
  payload[0] = prefix;
  payload.set(h160, 1);
  return base58check(payload);
}

/**
 * Valide une adresse Bitcoin avec vérification complète du checksum.
 * Supporte les adresses Legacy (P2PKH), P2SH, et Bech32 (SegWit).
 * 
 * @param address - L'adresse à valider
 * @param options - Options de validation
 * @returns true si l'adresse est valide et le checksum correct
 */
export function validateAddress(
  address: string, 
  options: { 
    allowTestnet?: boolean;
    requireSegwit?: boolean;
  } = {}
): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  // Vérifier la longueur raisonnable
  if (address.length < 26 || address.length > 90) {
    return false;
  }

  const { allowTestnet = false, requireSegwit = false } = options;

  // Essayer de décoder comme Bech32 (SegWit)
  const bech32Result = decodeBech32(address);
  if (bech32Result) {
    // Vérifier le réseau
    if (bech32Result.hrp === 'bc') {
      return true; // Mainnet
    }
    if (bech32Result.hrp === 'tb' && allowTestnet) {
      return true; // Testnet autorisé
    }
    return false; // Testnet non autorisé
  }

  // Si on exige SegWit, rejeter les adresses Legacy
  if (requireSegwit) {
    return false;
  }

  // Essayer de décoder comme Base58Check (Legacy ou P2SH)
  const base58Payload = base58checkDecode(address);
  if (!base58Payload) {
    return false; // Checksum invalide ou format incorrect
  }

  // Vérifier la version et la taille
  if (base58Payload.length !== 21) {
    return false;
  }

  const version = base58Payload[0];

  // Version byte pour P2PKH mainnet: 0x00, testnet: 0x6f
  // Version byte pour P2SH mainnet: 0x05, testnet: 0xc4
  const isP2PKHMainnet = version === 0x00;
  const isP2SHMainnet = version === 0x05;
  const isP2PKHTestnet = version === 0x6f;
  const isP2SHTestnet = version === 0xc4;

  if (isP2PKHMainnet || isP2SHMainnet) {
    return true; // Mainnet Legacy ou P2SH
  }

  if ((isP2PKHTestnet || isP2SHTestnet) && allowTestnet) {
    return true; // Testnet autorisé
  }

  return false; // Version inconnue ou testnet non autorisé
}

/**
 * Valide une adresse Bitcoin et retourne des détails sur le type d'adresse.
 * @returns Les détails de l'adresse ou null si invalide
 */
export function validateAddressDetailed(address: string): {
  valid: boolean;
  type?: 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'unknown';
  network?: 'mainnet' | 'testnet';
  error?: string;
} {
  if (!address || typeof address !== 'string') {
    return { valid: false, error: 'Adresse invalide' };
  }

  if (address.length < 26 || address.length > 90) {
    return { valid: false, error: 'Longueur d\'adresse invalide' };
  }

  // Essayer Bech32
  const bech32Result = decodeBech32(address);
  if (bech32Result) {
    const network = bech32Result.hrp === 'bc' ? 'mainnet' : 'testnet';
    let type: 'p2wpkh' | 'p2wsh' | 'p2tr' | 'unknown';
    
    if (bech32Result.version === 0) {
      type = bech32Result.program.length === 20 ? 'p2wpkh' : 'p2wsh';
    } else if (bech32Result.version === 1) {
      type = 'p2tr';
    } else {
      type = 'unknown';
    }

    return { valid: true, type, network };
  }

  // Essayer Base58Check
  const base58Payload = base58checkDecode(address);
  if (base58Payload) {
    if (base58Payload.length !== 21) {
      return { valid: false, error: 'Taille de payload invalide' };
    }

    const version = base58Payload[0];
    
    switch (version) {
      case 0x00:
        return { valid: true, type: 'p2pkh', network: 'mainnet' };
      case 0x05:
        return { valid: true, type: 'p2sh', network: 'mainnet' };
      case 0x6f:
        return { valid: true, type: 'p2pkh', network: 'testnet' };
      case 0xc4:
        return { valid: true, type: 'p2sh', network: 'testnet' };
      default:
        return { valid: false, error: 'Version byte inconnu' };
    }
  }

  return { valid: false, error: 'Checksum invalide ou format non reconnu' };
}

/**
 * Valide une adresse avant envoi de fonds.
 * Lève une exception si l'adresse est invalide.
 * @throws si l'adresse est invalide
 */
export function assertValidAddress(address: string, allowTestnet: boolean = false): void {
  const validation = validateAddressDetailed(address);
  
  if (!validation.valid) {
    throw new Error(`Adresse Bitcoin invalide: ${validation.error || 'inconnue'}`);
  }

  if (validation.network === 'testnet' && !allowTestnet) {
    throw new Error('Adresse testnet non autorisée en production');
  }
}

export function deriveWalletInfo(mnemonic: string, passphrase?: string): DerivedWalletInfo {
  console.log('[Bitcoin] Deriving wallet info from mnemonic...');
  const seed = mnemonicToSeed(mnemonic, passphrase);
  const master = HDKey.fromMasterSeed(seed);
  const account = master.derive(BIP44_BTC_PATH);

  const fp = master.fingerprint;
  const fingerprint = typeof fp === 'number'
    ? fp.toString(16).padStart(8, '0')
    : bytesToHex(fp as Uint8Array);

  const xpub = account.publicExtendedKey;

  const firstChild = account.deriveChild(0).deriveChild(0);
  const firstReceiveAddress = firstChild.publicKey
    ? pubkeyToSegwitAddress(firstChild.publicKey, true)
    : 'unknown';

  console.log('[Bitcoin] Derived wallet - fingerprint:', fingerprint);
  console.log('[Bitcoin] First receive address:', firstReceiveAddress);

  return {
    xpub,
    firstReceiveAddress,
    fingerprint,
  };
}

export function deriveReceiveAddresses(mnemonic: string, count: number = 5, passphrase?: string): string[] {
  const seed = mnemonicToSeed(mnemonic, passphrase);
  const master = HDKey.fromMasterSeed(seed);
  const account = master.derive(BIP44_BTC_PATH);

  const addresses: string[] = [];
  for (let i = 0; i < count; i++) {
    const child = account.deriveChild(0).deriveChild(i);
    if (child.publicKey) {
      addresses.push(pubkeyToSegwitAddress(child.publicKey, true));
    }
  }
  console.log('[Bitcoin] Derived', addresses.length, 'receive addresses');
  return addresses;
}

export function deriveChangeAddresses(mnemonic: string, count: number = 5, passphrase?: string): string[] {
  const seed = mnemonicToSeed(mnemonic, passphrase);
  const master = HDKey.fromMasterSeed(seed);
  const account = master.derive(BIP44_BTC_PATH);

  const addresses: string[] = [];
  for (let i = 0; i < count; i++) {
    const child = account.deriveChild(1).deriveChild(i); // branch interne m/84'/0'/0'/1/i
    if (child.publicKey) {
      addresses.push(pubkeyToSegwitAddress(child.publicKey, true));
    }
  }
  return addresses;
}

export function shortenAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}
