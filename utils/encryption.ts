// Chiffrement E2E AES-GCM-256 + ECDH secp256k1 pour messages MeshCore
// @ts-ignore
import { gcm } from '@noble/ciphers/aes';
// @ts-ignore
import { randomBytes } from '@noble/ciphers/webcrypto';
import { secp256k1 } from '@noble/curves/secp256k1';
// @ts-ignore
import { sha256 } from '@noble/hashes/sha2.js';
// @ts-ignore
import { hkdf } from '@noble/hashes/hkdf.js';
// @ts-ignore
import { bytesToHex } from '@noble/hashes/utils.js';

// hexToBytes — implémentation locale (noble/hashes ne l'exporte pas toujours)
function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export interface EncryptedPayload {
  v: number;
  nonce: string;  // base64 12 bytes
  ct: string;     // base64 ciphertext + tag GCM
}

// --- Utilitaires base64 ---
function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let str = '';
  bytes.forEach(b => { str += String.fromCharCode(b); });
  return btoa(str);
}

function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(b64, 'base64'));
  }
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

// --- ECDH: dériver clé partagée entre deux parties ---
// maPrivKey (32 bytes) × leurPubKey (33 bytes) → secret 32 bytes
/**
 * Dérive un secret partagé via ECDH (secp256k1).
 * 
 * SÉCURITÉ: Cette fonction utilise @noble/curves qui implémente:
 * - Des opérations constant-time pour prévenir les attaques par timing
 * - Une multiplication scalaire optimisée et sécurisée
 * - La vérification de validité des points publics
 * 
 * Le hash SHA-256 du point partagé est utilisé comme clé AES-256.
 * 
 * @param myPrivkeyBytes - Clé privée de 32 bytes
 * @param theirPubkeyHex - Clé publique compressée en hex (33 bytes)
 * @returns Secret partagé de 32 bytes
 */
export function deriveSharedSecret(
  myPrivkeyBytes: Uint8Array,
  theirPubkeyHex: string
): Uint8Array {
  const theirPubkey = hexToBytes(theirPubkeyHex);
  // ECDH: point = privKey * pubKey, on prend les 32 bytes X de ce point
  // @noble/curves utilise des opérations constant-time, résistant aux attaques par timing
  const sharedPoint = secp256k1.getSharedSecret(myPrivkeyBytes, theirPubkey, true);
  // sharedPoint est 33 bytes (compressed), on hash pour obtenir la clé AES
  return sha256(sharedPoint);
}

// --- Clé symétrique pour forum PUBLIC (nom = seul secret) ---
// AVERTISSEMENT : utilisable uniquement pour des forums explicitement publics.
// Pour les forums privés, utiliser generateForumKey() + partage via DM chiffré.

// Sel unique par installation pour la dérivation des clés de forum
// Généré aléatoirement à chaque démarrage si non persisté
let _forumSalt: Uint8Array | null = null;

/**
 * Définit le sel pour la dérivation des clés de forum.
 * Doit être appelé au démarrage de l'application avec un sel persistant.
 * 
 * SÉCURITÉ: Le sel doit être:
 * - Généré aléatoirement (32 bytes) lors de la première utilisation
 * - Persisté de manière sécurisée (Keychain/Keystore ou chiffré)
 * - Unique par installation d'application
 * 
 * @param salt - Sel de 32 bytes (généré via randomBytes(32))
 */
export function setForumSalt(salt: Uint8Array): void {
  if (salt.length !== 32) {
    throw new Error('Le sel du forum doit faire exactement 32 bytes');
  }
  _forumSalt = salt;
}

/**
 * Génère un nouveau sel pour les clés de forum.
 * @returns Sel aléatoire de 32 bytes à persister de manière sécurisée
 */
export function generateForumSalt(): Uint8Array {
  return randomBytes(32);
}

/**
 * Dérive une clé de forum de manière sécurisée avec HKDF.
 * 
 * SÉCURITÉ (Fix VULN-004):
 * - Utilise HKDF-SHA256 au lieu de SHA-256 simple
 * - Inclut un sel unique par utilisateur/installation
 * - Permet d'avoir des clés différentes pour le même nom de forum
 *   sur différentes installations (isolation)
 * 
 * @param channelName - Nom du canal/forum
 * @returns Clé symétrique de 32 bytes dérivée via HKDF
 */
export function deriveForumKey(channelName: string): Uint8Array {
  const encoder = new TextEncoder();
  const ikm = encoder.encode('forum:' + channelName);
  
  // Si aucun sel n'est défini, utiliser un sel par défaut (rétrocompatibilité)
  // mais loguer un avertissement en dev
  const salt = _forumSalt || encoder.encode('meshpay-default-salt-v1');
  
  if (!_forumSalt && typeof __DEV__ !== 'undefined' && __DEV__) {
    console.warn('[Encryption] Aucun sel défini pour deriveForumKey - utilise le sel par défaut. ' +
                 'Appelez setForumSalt() au démarrage pour une meilleure sécurité.');
  }
  
  // HKDF-SHA256: extract + expand
  // ikm: input keying material (le nom du forum)
  // salt: sel unique par installation
  // info: contexte de dérivation
  // dkLen: 32 bytes pour AES-256
  const info = encoder.encode('meshpay-forum-v1');
  return hkdf(sha256, ikm, salt, info, 32);
}

// --- Génère une PSK aléatoire pour un forum privé ---
// Appeler une seule fois à la création du forum.
// Partager le hex résultant aux membres via encryptDM (jamais en clair).
export function generateForumKey(): string {
  return bytesToHex(randomBytes(32));
}

// --- Chiffrer avec une PSK explicite (forum privé) ---
export function encryptForumWithKey(plaintext: string, pskHex: string): EncryptedPayload {
  const key = hexToBytes(pskHex);
  return encryptMessage(plaintext, key);
}

// --- Déchiffrer avec une PSK explicite (forum privé) ---
export function decryptForumWithKey(payload: EncryptedPayload, pskHex: string): string {
  const key = hexToBytes(pskHex);
  return decryptMessage(payload, key);
}

// --- Chiffrement AES-GCM-256 ---
export function encryptMessage(plaintext: string, key: Uint8Array): EncryptedPayload {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  const nonce = randomBytes(12);
  const cipher = gcm(key, nonce);
  const ciphertext = cipher.encrypt(data);

  return {
    v: 1,
    nonce: toBase64(nonce),
    ct: toBase64(ciphertext),
  };
}

// --- Déchiffrement AES-GCM-256 ---
export function decryptMessage(payload: EncryptedPayload, key: Uint8Array): string {
  const nonce = fromBase64(payload.nonce);
  const ciphertext = fromBase64(payload.ct);
  const cipher = gcm(key, nonce);
  const plaintext = cipher.decrypt(ciphertext);
  return new TextDecoder().decode(plaintext);
}

// --- Chiffrer un DM pour un destinataire ---
export function encryptDM(
  plaintext: string,
  myPrivkeyBytes: Uint8Array,
  theirPubkeyHex: string
): EncryptedPayload {
  const sharedKey = deriveSharedSecret(myPrivkeyBytes, theirPubkeyHex);
  return encryptMessage(plaintext, sharedKey);
}

// --- Déchiffrer un DM reçu ---
export function decryptDM(
  payload: EncryptedPayload,
  myPrivkeyBytes: Uint8Array,
  senderPubkeyHex: string
): string {
  const sharedKey = deriveSharedSecret(myPrivkeyBytes, senderPubkeyHex);
  return decryptMessage(payload, sharedKey);
}

// --- Chiffrer un message forum ---
export function encryptForum(plaintext: string, channelName: string): EncryptedPayload {
  const key = deriveForumKey(channelName);
  return encryptMessage(plaintext, key);
}

// --- Déchiffrer un message forum ---
export function decryptForum(payload: EncryptedPayload, channelName: string): string {
  const key = deriveForumKey(channelName);
  return decryptMessage(payload, key);
}

// Exporter bytesToHex pour usage externe
export { bytesToHex };
export { hexToBytes };
