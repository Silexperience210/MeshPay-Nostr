/**
 * @fileoverview CryptoWrapper - Abstraction cryptographique unifiée pour Hermès Engine
 * 
 * Fournit une interface unifiée pour les opérations cryptographiques utilisées dans
 * MeshPay-Nostr, incluant le chiffrement symétrique (AES-GCM), asymétrique (ECIES/secp256k1),
 * HMAC, hashing et dérivation de clés.
 * 
 * @module engine/utils/CryptoWrapper
 * @version 1.0.0
 * @author MeshPay Team
 */

// Imports @noble sans extension .js pour compatibilité Metro
import { gcm } from '@noble/ciphers/aes';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils.js';

// ============================================================================
// Constantes de sécurité
// ============================================================================

/** Taille de la clé AES en bytes (256 bits) */
export const AES_KEY_SIZE = 32;

/** Taille du vecteur d'initialisation en bytes (96 bits pour GCM) */
export const AES_IV_SIZE = 12;

/** Taille du tag d'authentification GCM en bytes (128 bits) */
export const AES_TAG_SIZE = 16;

/** Nombre d'itérations PBKDF2 par défaut (100 000) */
export const PBKDF2_ITERATIONS = 100000;

/** Taille du sel pour PBKDF2 en bytes (128 bits) */
export const PBKDF2_SALT_SIZE = 16;

/** Taille de la clé dérivée en bytes */
export const DERIVED_KEY_SIZE = 32;

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Payload chiffré contenant toutes les données nécessaires au déchiffrement
 */
export interface EncryptedPayload {
  /** Ciphertext en hexadécimal */
  ciphertext: string;
  /** Vecteur d'initialisation en hexadécimal */
  iv: string;
  /** Tag d'authentification GCM en hexadécimal */
  tag: string;
  /** Sel optionnel utilisé pour la dérivation de clé (en hexadécimal) */
  salt?: string;
}

/**
 * Interface principale pour les opérations cryptographiques
 */
export interface CryptoWrapper {
  /**
   * Chiffre un texte en clair avec AES-GCM
   * @param plaintext - Le texte à chiffrer
   * @param key - La clé de chiffrement (32 bytes)
   * @returns Le payload chiffré
   * @throws {Error} Si la clé est invalide ou si le chiffrement échoue
   */
  encrypt(plaintext: string, key: Uint8Array): Promise<EncryptedPayload>;

  /**
   * Déchiffre un payload AES-GCM
   * @param payload - Le payload chiffré
   * @param key - La clé de déchiffrement (32 bytes)
   * @returns Le texte en clair
   * @throws {Error} Si la clé est invalide ou si le déchiffrement échoue
   */
  decrypt(payload: EncryptedPayload, key: Uint8Array): Promise<string>;

  /**
   * Chiffre un texte avec ECIES/secp256k1
   * @param plaintext - Le texte à chiffrer
   * @param publicKey - La clé publique du destinataire (33 bytes compressée ou 65 bytes non compressée)
   * @returns Le payload chiffré
   * @throws {Error} Si la clé publique est invalide
   */
  encryptAsymmetric(plaintext: string, publicKey: Uint8Array): Promise<EncryptedPayload>;

  /**
   * Déchiffre un payload ECIES/secp256k1
   * @param payload - Le payload chiffré
   * @param privateKey - La clé privée du destinataire (32 bytes)
   * @returns Le texte en clair
   * @throws {Error} Si la clé privée est invalide ou si le déchiffrement échoue
   */
  decryptAsymmetric(payload: EncryptedPayload, privateKey: Uint8Array): Promise<string>;

  /**
   * Signe des données avec HMAC-SHA256
   * @param data - Les données à signer
   * @param key - La clé HMAC
   * @returns La signature en hexadécimal
   * @throws {Error} Si la clé est invalide
   */
  sign(data: string, key: Uint8Array): Promise<string>;

  /**
   * Vérifie une signature HMAC-SHA256
   * @param data - Les données signées
   * @param signature - La signature en hexadécimal
   * @param key - La clé HMAC
   * @returns true si la signature est valide
   * @throws {Error} Si les entrées sont invalides
   */
  verify(data: string, signature: string, key: Uint8Array): Promise<boolean>;

  /**
   * Calcule le hash SHA256
   * @param data - Les données à hasher (string ou Uint8Array)
   * @returns Le hash en bytes
   */
  sha256(data: string | Uint8Array): Promise<Uint8Array>;

  /**
   * Hash un mot de passe avec PBKDF2
   * @param password - Le mot de passe
   * @param salt - Le sel optionnel (généré aléatoirement si non fourni)
   * @returns Le hash et le sel utilisé
   */
  hashPassword(password: string, salt?: Uint8Array): Promise<{ hash: Uint8Array; salt: Uint8Array }>;

  /**
   * Dérive une clé à partir d'un mot de passe avec PBKDF2
   * @param password - Le mot de passe
   * @param salt - Le sel
   * @param iterations - Nombre d'itérations (défaut: 100000)
   * @returns La clé dérivée
   */
  deriveKey(password: string, salt: Uint8Array, iterations?: number): Promise<Uint8Array>;

  /**
   * Génère une clé aléatoire de 32 bytes
   * @returns La clé générée
   */
  generateKey(): Promise<Uint8Array>;

  /**
   * Convertit des bytes en hexadécimal
   * @param bytes - Les bytes à convertir
   * @returns La chaîne hexadécimale
   */
  bytesToHex(bytes: Uint8Array): string;

  /**
   * Convertit une chaîne hexadécimale en bytes
   * @param hex - La chaîne hexadécimale
   * @returns Les bytes
   * @throws {Error} Si le format hex est invalide
   */
  hexToBytes(hex: string): Uint8Array;

  /**
   * Convertit une chaîne UTF-8 en bytes
   * @param str - La chaîne à convertir
   * @returns Les bytes
   */
  utf8ToBytes(str: string): Uint8Array;

  /**
   * Convertit des bytes en chaîne UTF-8
   * @param bytes - Les bytes à convertir
   * @returns La chaîne UTF-8
   * @throws {Error} Si les bytes ne forment pas une UTF-8 valide
   */
  bytesToUtf8(bytes: Uint8Array): string;
}

// ============================================================================
// Fonctions utilitaires
// ============================================================================

/**
 * Génère des bytes aléatoires cryptographiquement sécurisés
 * @param size - Nombre de bytes à générer
 * @returns Les bytes aléatoires
 * @throws {Error} Si size est négatif ou trop grand
 */
export function randomBytes(size: number): Uint8Array {
  if (size < 0) {
    throw new Error('randomBytes: size must be non-negative');
  }
  if (size > 65536) {
    throw new Error('randomBytes: size exceeds maximum (65536)');
  }
  
  // Utilise @noble/hashes/utils qui fonctionne partout (Node, RN, Web)
  return nobleRandomBytes(size);
}

/**
 * Compare deux tableaux de bytes en temps constant pour éviter les attaques timing
 * @param a - Premier tableau
 * @param b - Deuxième tableau
 * @returns true si les tableaux sont identiques
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * Vérifie si une clé est valide (bonne taille, non vide)
 * @param key - La clé à vérifier
 * @param expectedSize - Taille attendue en bytes (défaut: 32)
 * @returns true si la clé est valide
 */
export function isValidKey(key: Uint8Array, expectedSize: number = AES_KEY_SIZE): boolean {
  return key instanceof Uint8Array && 
         key.length === expectedSize && 
         key.some(byte => byte !== 0);
}

/**
 * Valide une clé et lance une erreur si invalide
 * @param key - La clé à valider
 * @param name - Nom de la clé pour le message d'erreur
 * @param expectedSize - Taille attendue
 * @throws {Error} Si la clé est invalide
 */
function validateKey(key: Uint8Array, name: string, expectedSize: number = AES_KEY_SIZE): void {
  if (!(key instanceof Uint8Array)) {
    throw new Error(`${name} must be a Uint8Array`);
  }
  if (key.length !== expectedSize) {
    throw new Error(`${name} must be ${expectedSize} bytes, got ${key.length}`);
  }
  if (!key.some(byte => byte !== 0)) {
    throw new Error(`${name} cannot be all zeros`);
  }
}

/**
 * Valide un payload chiffré
 * @param payload - Le payload à valider
 * @throws {Error} Si le payload est invalide
 */
function validatePayload(payload: EncryptedPayload): void {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid payload: must be an object');
  }
  if (typeof payload.ciphertext !== 'string') {
    throw new Error('Invalid payload: ciphertext must be a hex string');
  }
  if (!payload.iv || typeof payload.iv !== 'string') {
    throw new Error('Invalid payload: iv must be a hex string');
  }
  if (!payload.tag || typeof payload.tag !== 'string') {
    throw new Error('Invalid payload: tag must be a hex string');
  }
}

// ============================================================================
// Classe principale
// ============================================================================

/**
 * Implémentation de CryptoWrapper utilisant les bibliothèques @noble/*
 * 
 * Cette classe fournit une abstraction cryptographique complète et sécurisée
 * pour toutes les opérations de chiffrement, signature et hashing.
 */
export class NobleCryptoWrapper implements CryptoWrapper {

  // -------------------------------------------------------------------------
  // Chiffrement symétrique (AES-GCM)
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   */
  async encrypt(plaintext: string, key: Uint8Array): Promise<EncryptedPayload> {
    validateKey(key, 'Encryption key', AES_KEY_SIZE);

    try {
      const iv = randomBytes(AES_IV_SIZE);
      const plaintextBytes = this.utf8ToBytes(plaintext);
      
      // Chiffrement AES-GCM avec @noble/ciphers
      const cipher = gcm(key, iv);
      const ciphertext = cipher.encrypt(plaintextBytes);
      
      // Séparer le ciphertext du tag d'authentification
      // GCM place le tag à la fin du ciphertext
      const actualCiphertext = ciphertext.slice(0, -AES_TAG_SIZE);
      const tag = ciphertext.slice(-AES_TAG_SIZE);

      return {
        ciphertext: this.bytesToHex(actualCiphertext),
        iv: this.bytesToHex(iv),
        tag: this.bytesToHex(tag),
      };
    } catch (error) {
      throw new Error(`Encryption failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  /**
   * @inheritdoc
   */
  async decrypt(payload: EncryptedPayload, key: Uint8Array): Promise<string> {
    validateKey(key, 'Decryption key', AES_KEY_SIZE);
    validatePayload(payload);

    try {
      const iv = this.hexToBytes(payload.iv);
      const ciphertext = this.hexToBytes(payload.ciphertext);
      const tag = this.hexToBytes(payload.tag);

      // Vérifier la taille de l'IV
      if (iv.length !== AES_IV_SIZE) {
        throw new Error(`Invalid IV size: expected ${AES_IV_SIZE} bytes, got ${iv.length}`);
      }

      // Vérifier la taille du tag
      if (tag.length !== AES_TAG_SIZE) {
        throw new Error(`Invalid tag size: expected ${AES_TAG_SIZE} bytes, got ${tag.length}`);
      }

      // Reconstituer le message chiffré avec le tag
      const fullCiphertext = new Uint8Array(ciphertext.length + tag.length);
      fullCiphertext.set(ciphertext);
      fullCiphertext.set(tag, ciphertext.length);

      // Déchiffrement AES-GCM
      const cipher = gcm(key, iv);
      const plaintext = cipher.decrypt(fullCiphertext);

      return this.bytesToUtf8(plaintext);
    } catch (error) {
      if (error instanceof Error && error.message.includes('tag')) {
        throw new Error('Decryption failed: authentication tag mismatch (data may be corrupted or tampered)');
      }
      throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  // -------------------------------------------------------------------------
  // Chiffrement asymétrique (ECIES/secp256k1)
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   */
  async encryptAsymmetric(plaintext: string, publicKey: Uint8Array): Promise<EncryptedPayload> {
    try {
      // Valider la clé publique
      const point = secp256k1.ProjectivePoint.fromHex(publicKey);
      
      // Générer une clé éphémère
      const ephemeralPrivateKey = secp256k1.utils.randomPrivateKey();
      const ephemeralPublicKey = secp256k1.getPublicKey(ephemeralPrivateKey, true);

      // Calculer le shared secret avec ECDH
      const sharedSecret = secp256k1.getSharedSecret(ephemeralPrivateKey, publicKey);
      
      // Utiliser les 32 derniers bytes du shared secret comme clé AES
      const encryptionKey = sharedSecret.slice(1, 33); // Skip le prefix byte

      // Chiffrement symétrique avec la clé dérivée
      const encrypted = await this.encrypt(plaintext, encryptionKey);

      // Inclure la clé publique éphémère dans le payload
      // Le format est: ephemeralPublicKey (33 bytes) + ciphertext
      return {
        ...encrypted,
        ciphertext: this.bytesToHex(ephemeralPublicKey) + encrypted.ciphertext,
      };
    } catch (error) {
      throw new Error(`Asymmetric encryption failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  /**
   * @inheritdoc
   */
  async decryptAsymmetric(payload: EncryptedPayload, privateKey: Uint8Array): Promise<string> {
    validateKey(privateKey, 'Private key', 32);

    try {
      validatePayload(payload);
      
      // Extraire la clé publique éphémère du ciphertext
      const fullCiphertextHex = payload.ciphertext;
      if (fullCiphertextHex.length < 66) { // 33 bytes * 2 hex chars
        throw new Error('Invalid ciphertext: too short to contain ephemeral public key');
      }

      const ephemeralPublicKeyHex = fullCiphertextHex.slice(0, 66);
      const actualCiphertextHex = fullCiphertextHex.slice(66);

      const ephemeralPublicKey = this.hexToBytes(ephemeralPublicKeyHex);

      // Valider la clé publique éphémère
      secp256k1.ProjectivePoint.fromHex(ephemeralPublicKey);

      // Calculer le shared secret
      const sharedSecret = secp256k1.getSharedSecret(privateKey, ephemeralPublicKey);
      const decryptionKey = sharedSecret.slice(1, 33);

      // Déchiffrer avec la clé dérivée
      return await this.decrypt(
        { ...payload, ciphertext: actualCiphertextHex },
        decryptionKey
      );
    } catch (error) {
      throw new Error(`Asymmetric decryption failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  // -------------------------------------------------------------------------
  // HMAC
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   */
  async sign(data: string, key: Uint8Array): Promise<string> {
    if (typeof data !== 'string') {
      throw new Error('Data must be a string');
    }
    if (!(key instanceof Uint8Array) || key.length === 0) {
      throw new Error('Key must be a non-empty Uint8Array');
    }

    try {
      const dataBytes = this.utf8ToBytes(data);
      const signature = hmac(nobleSha256, key, dataBytes);
      return this.bytesToHex(signature);
    } catch (error) {
      throw new Error(`Signing failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  /**
   * @inheritdoc
   */
  async verify(data: string, signature: string, key: Uint8Array): Promise<boolean> {
    if (typeof data !== 'string') {
      throw new Error('Data must be a string');
    }
    if (typeof signature !== 'string') {
      throw new Error('Signature must be a hex string');
    }
    if (!(key instanceof Uint8Array) || key.length === 0) {
      throw new Error('Key must be a non-empty Uint8Array');
    }

    try {
      const expectedSignature = await this.sign(data, key);
      const expectedBytes = this.hexToBytes(expectedSignature);
      const actualBytes = this.hexToBytes(signature);
      
      return timingSafeEqual(expectedBytes, actualBytes);
    } catch (error) {
      throw new Error(`Verification failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  // -------------------------------------------------------------------------
  // Hashing
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   */
  async sha256(data: string | Uint8Array): Promise<Uint8Array> {
    try {
      const bytes = typeof data === 'string' ? this.utf8ToBytes(data) : data;
      return nobleSha256(bytes);
    } catch (error) {
      throw new Error(`SHA256 failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  /**
   * @inheritdoc
   */
  async hashPassword(
    password: string, 
    salt?: Uint8Array
  ): Promise<{ hash: Uint8Array; salt: Uint8Array }> {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('Password must be a non-empty string');
    }

    const usedSalt = salt ?? randomBytes(PBKDF2_SALT_SIZE);
    
    if (!(usedSalt instanceof Uint8Array)) {
      throw new Error('Salt must be a Uint8Array');
    }

    try {
      const hash = await this.deriveKey(password, usedSalt, PBKDF2_ITERATIONS);
      return { hash, salt: usedSalt };
    } catch (error) {
      throw new Error(`Password hashing failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  // -------------------------------------------------------------------------
  // Key derivation
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   */
  async deriveKey(
    password: string, 
    salt: Uint8Array, 
    iterations: number = PBKDF2_ITERATIONS
  ): Promise<Uint8Array> {
    if (typeof password !== 'string') {
      throw new Error('Password must be a string');
    }
    if (!(salt instanceof Uint8Array) || salt.length === 0) {
      throw new Error('Salt must be a non-empty Uint8Array');
    }
    if (iterations < 1000) {
      throw new Error('Iterations must be at least 1000');
    }

    try {
      const passwordBytes = this.utf8ToBytes(password);
      return await pbkdf2Async(nobleSha256, passwordBytes, salt, {
        c: iterations,
        dkLen: DERIVED_KEY_SIZE,
      });
    } catch (error) {
      throw new Error(`Key derivation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  /**
   * @inheritdoc
   */
  async generateKey(): Promise<Uint8Array> {
    return randomBytes(AES_KEY_SIZE);
  }

  // -------------------------------------------------------------------------
  // Encoding helpers
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   */
  bytesToHex(bytes: Uint8Array): string {
    if (!(bytes instanceof Uint8Array)) {
      throw new Error('Input must be a Uint8Array');
    }
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * @inheritdoc
   */
  hexToBytes(hex: string): Uint8Array {
    if (typeof hex !== 'string') {
      throw new Error('Input must be a string');
    }
    if (hex.length % 2 !== 0) {
      throw new Error('Hex string must have an even length');
    }
    if (!/^[0-9a-fA-F]*$/.test(hex)) {
      throw new Error('Hex string contains invalid characters');
    }
    
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
  }

  /**
   * @inheritdoc
   */
  utf8ToBytes(str: string): Uint8Array {
    if (typeof str !== 'string') {
      throw new Error('Input must be a string');
    }
    return new TextEncoder().encode(str);
  }

  /**
   * @inheritdoc
   */
  bytesToUtf8(bytes: Uint8Array): string {
    if (!(bytes instanceof Uint8Array)) {
      throw new Error('Input must be a Uint8Array');
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error('Invalid UTF-8 sequence');
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

/**
 * Instance singleton de NobleCryptoWrapper
 */
export const cryptoWrapper = new NobleCryptoWrapper();

/**
 * Retourne l'instance singleton de CryptoWrapper
 * @returns L'instance CryptoWrapper
 */
export function getCryptoWrapper(): CryptoWrapper {
  return cryptoWrapper;
}

// Export par défaut
export default cryptoWrapper;
