/**
 * UnifiedIdentityManager - Gestionnaire d'identité unifiée
 * 
 * Gère la création, le stockage sécurisé et le déverrouillage des identités
 * dérivées depuis une seed mnemonic unique.
 * 
 * Caractéristiques:
 * - Stockage chiffré des clés privées (PBKDF2 + AES-GCM)
 * - Export/import de backups chiffrés
 * - Migration depuis l'ancien système (wallet + nostr séparés)
 * - Intégration avec HermesEngine pour les événements
 */

import * as SecureStore from 'expo-secure-store';
// @ts-ignore - subpath exports use .js extension
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
// @ts-ignore - subpath exports use .js extension
import { sha256 } from '@noble/hashes/sha2.js';
// @ts-ignore - subpath exports use .js extension
import { gcm } from '@noble/ciphers/aes.js';
// @ts-ignore - subpath exports use .js extension
import { randomBytes } from '@noble/hashes/utils.js';
import { bytesToHex } from '@/utils/bitcoin';
import { deriveUnifiedIdentity, UnifiedIdentity, BitcoinIdentity, NostrIdentity, MeshCoreIdentity } from './Derivation';
import { HermesEngine, hermes } from '../HermesEngine';
import { EventType } from '../types';

// ─── Constantes ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'unified_identity_v1';
const ENCRYPTION_VERSION = 1;
const PBKDF2_ITERATIONS = 100000;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Identité avec clés privées chiffrées (pour stockage) */
export interface StoredIdentity {
  bitcoin: BitcoinIdentity;
  nostr: Omit<NostrIdentity, 'privkey'> & { privkey: string }; // Chiffré
  meshcore: Omit<MeshCoreIdentity, 'privkey'> & { privkey: string }; // Chiffré
  metadata: UnifiedIdentity['metadata'];
}

/** Structure d'un backup chiffré */
export interface EncryptedBackup {
  version: string;
  encryptedData: string;
  createdAt: number;
  salt: string;
  iv: string;
}

/** Options de création d'identité */
export interface CreateIdentityOptions {
  /** Force de la phrase mnémonique (12 ou 24 mots) */
  strength?: 12 | 24;
  /** Mot de passe pour le chiffrement */
  password: string;
  /** Passphrase optionnelle BIP39 */
  passphrase?: string;
}

/** Résultat de création d'identité */
export interface CreateIdentityResult {
  /** La phrase mnémonique (à sauvegarder par l'utilisateur!) */
  mnemonic: string;
  /** L'identité dérivée (sans clés privées déchiffrées) */
  identity: Omit<UnifiedIdentity, 'nostr' | 'meshcore'> & {
    nostr: Omit<NostrIdentity, 'privkey'>;
    meshcore: Omit<MeshCoreIdentity, 'privkey'>;
  };
}

// ─── Erreurs personnalisées ───────────────────────────────────────────────────

export class IdentityError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

export class DecryptionError extends IdentityError {
  constructor(message: string = 'Mot de passe incorrect') {
    super(message, 'DECRYPTION_FAILED');
    this.name = 'DecryptionError';
  }
}

export class IdentityNotFoundError extends IdentityError {
  constructor() {
    super('Aucune identité trouvée', 'IDENTITY_NOT_FOUND');
    this.name = 'IdentityNotFoundError';
  }
}

// ─── UnifiedIdentityManager ───────────────────────────────────────────────────

export class UnifiedIdentityManager {
  private identity: UnifiedIdentity | null = null;
  private isUnlocked = false;
  private hermesEngine: HermesEngine;

  constructor(hermesEngine: HermesEngine = hermes) {
    this.hermesEngine = hermesEngine;
  }

  // ─── Création ───────────────────────────────────────────────────────────────

  /**
   * Crée une nouvelle identité unifiée depuis un mnemonic.
   * 
   * @param mnemonic - Phrase mnémonique BIP39
   * @param password - Mot de passe pour chiffrer les clés privées
   * @returns L'identité créée (sans les clés privées déchiffrées)
   */
  async createIdentity(mnemonic: string, password: string): Promise<CreateIdentityResult> {
    // Dériver toutes les identités
    const identity = deriveUnifiedIdentity(mnemonic);

    // Chiffrer les clés privées
    const encryptedNostrPrivkey = await this.encryptKey(identity.nostr.privkey, password);
    const encryptedMeshcorePrivkey = await this.encryptKey(identity.meshcore.privkey, password);

    // Créer l'identité stockable (avec clés chiffrées)
    const storedIdentity: StoredIdentity = {
      bitcoin: identity.bitcoin,
      nostr: {
        pubkey: identity.nostr.pubkey,
        npub: identity.nostr.npub,
        privkey: encryptedNostrPrivkey,
      },
      meshcore: {
        pubkey: identity.meshcore.pubkey,
        nodeId: identity.meshcore.nodeId,
        privkey: encryptedMeshcorePrivkey,
      },
      metadata: identity.metadata,
    };

    // Sauvegarder dans le stockage sécurisé
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(storedIdentity));

    // Mettre à jour l'état interne
    this.identity = identity;
    this.isUnlocked = true;

    // Émettre un événement
    await this.hermesEngine.emit({
      type: EventType.WALLET_INITIALIZED,
      transport: 'internal' as any,
      from: identity.meshcore.nodeId,
      to: '*',
      payload: {
        bitcoinAddress: identity.bitcoin.firstAddress,
        nostrPubkey: identity.nostr.pubkey,
        meshcoreNodeId: identity.meshcore.nodeId,
      },
      meta: {},
    });

    // Retourner le résultat (sans les clés privées déchiffrées)
    return {
      mnemonic,
      identity: {
        bitcoin: identity.bitcoin,
        nostr: {
          pubkey: identity.nostr.pubkey,
          npub: identity.nostr.npub,
        },
        meshcore: {
          pubkey: identity.meshcore.pubkey,
          nodeId: identity.meshcore.nodeId,
        },
        metadata: identity.metadata,
      },
    };
  }

  // ─── Déverrouillage ─────────────────────────────────────────────────────────

  /**
   * Déverrouille l'identité avec le mot de passe.
   * Charge et déchiffre les clés privées depuis le stockage sécurisé.
   * 
   * @param password - Mot de passe de déchiffrement
   * @returns true si le déverrouillage a réussi
   */
  async unlock(password: string): Promise<boolean> {
    try {
      const storedJson = await SecureStore.getItemAsync(STORAGE_KEY);
      if (!storedJson) {
        throw new IdentityNotFoundError();
      }

      const stored: StoredIdentity = JSON.parse(storedJson);

      // Déchiffrer les clés privées
      const nostrPrivkey = await this.decryptKey(stored.nostr.privkey, password);
      const meshcorePrivkey = await this.decryptKey(stored.meshcore.privkey, password);

      // Reconstruire l'identité complète
      this.identity = {
        bitcoin: stored.bitcoin,
        nostr: {
          ...stored.nostr,
          privkey: nostrPrivkey,
        },
        meshcore: {
          ...stored.meshcore,
          privkey: meshcorePrivkey,
        },
        metadata: stored.metadata,
      };

      this.isUnlocked = true;
      return true;
    } catch (error) {
      if (error instanceof IdentityError) {
        throw error;
      }
      // Si le déchiffrement échoue, c'est probablement un mauvais mot de passe
      throw new DecryptionError();
    }
  }

  /**
   * Vérifie si une identité existe dans le stockage.
   */
  async hasIdentity(): Promise<boolean> {
    const stored = await SecureStore.getItemAsync(STORAGE_KEY);
    return stored !== null;
  }

  /**
   * Verrouille l'identité (efface les clés privées de la mémoire).
   */
  lock(): void {
    this.identity = null;
    this.isUnlocked = false;
  }

  // ─── Accès aux données ──────────────────────────────────────────────────────

  /**
   * Retourne l'identité complète (nécessite unlock avant).
   * 
   * @throws {IdentityError} Si l'identité n'est pas déverrouillée
   */
  getIdentity(): UnifiedIdentity {
    if (!this.isUnlocked || !this.identity) {
      throw new IdentityError('Identité verrouillée', 'IDENTITY_LOCKED');
    }
    return this.identity;
  }

  /**
   * Retourne l'identité publique (sans les clés privées).
   * Ne nécessite pas de déverrouillage.
   */
  async getPublicIdentity(): Promise<Omit<UnifiedIdentity, 'nostr' | 'meshcore'> & {
    nostr: Omit<NostrIdentity, 'privkey'>;
    meshcore: Omit<MeshCoreIdentity, 'privkey'>;
  } | null> {
    const storedJson = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!storedJson) return null;

    const stored: StoredIdentity = JSON.parse(storedJson);
    return {
      bitcoin: stored.bitcoin,
      nostr: {
        pubkey: stored.nostr.pubkey,
        npub: stored.nostr.npub,
      },
      meshcore: {
        pubkey: stored.meshcore.pubkey,
        nodeId: stored.meshcore.nodeId,
      },
      metadata: stored.metadata,
    };
  }

  /**
   * Retourne le statut de verrouillage.
   */
  getIsUnlocked(): boolean {
    return this.isUnlocked;
  }

  // ─── Export/Import ──────────────────────────────────────────────────────────

  /**
   * Exporte un backup chiffré de l'identité.
   * 
   * @param password - Mot de passe actuel pour vérifier l'accès
   * @returns JSON string du backup chiffré
   */
  async exportBackup(password: string): Promise<string> {
    // Vérifier le mot de passe en tentant de déverrouiller
    const canUnlock = await this.unlock(password);
    if (!canUnlock) {
      throw new DecryptionError();
    }

    const identity = this.getIdentity();

    // Créer le backup
    const backupData = JSON.stringify(identity);
    const encrypted = await this.encryptKey(backupData, password);

    // Extraire salt et iv du chiffré
    const { salt, iv } = JSON.parse(encrypted);

    const backup: EncryptedBackup = {
      version: '1.0',
      encryptedData: encrypted,
      createdAt: Date.now(),
      salt,
      iv,
    };

    return JSON.stringify(backup);
  }

  /**
   * Importe une identité depuis un backup chiffré.
   * 
   * @param backupJson - JSON string du backup
   * @param password - Mot de passe de déchiffrement
   */
  async importBackup(backupJson: string, password: string): Promise<void> {
    const backup: EncryptedBackup = JSON.parse(backupJson);

    // Déchiffrer le backup
    const decrypted = await this.decryptKey(backup.encryptedData, password);
    const identity: UnifiedIdentity = JSON.parse(decrypted);

    // Re-chiffrer avec le même mot de passe (pour avoir le bon format)
    const encryptedNostrPrivkey = await this.encryptKey(identity.nostr.privkey, password);
    const encryptedMeshcorePrivkey = await this.encryptKey(identity.meshcore.privkey, password);

    const storedIdentity: StoredIdentity = {
      bitcoin: identity.bitcoin,
      nostr: {
        pubkey: identity.nostr.pubkey,
        npub: identity.nostr.npub,
        privkey: encryptedNostrPrivkey,
      },
      meshcore: {
        pubkey: identity.meshcore.pubkey,
        nodeId: identity.meshcore.nodeId,
        privkey: encryptedMeshcorePrivkey,
      },
      metadata: identity.metadata,
    };

    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(storedIdentity));

    this.identity = identity;
    this.isUnlocked = true;
  }

  // ─── Migration ──────────────────────────────────────────────────────────────

  /**
   * Migre depuis l'ancien système (wallet + nostr séparés).
   * 
   * Vérifie que la clé Nostr fournie correspond bien à la dérivation
   * depuis le wallet mnemonic.
   * 
   * @param walletMnemonic - Mnemonic du wallet existant
   * @param nostrPrivkey - Clé privée Nostr existante
   * @param password - Nouveau mot de passe pour le chiffrement
   * @throws {IdentityError} Si les clés ne correspondent pas
   */
  async migrateFromLegacy(
    walletMnemonic: string,
    nostrPrivkey: string,
    password: string
  ): Promise<CreateIdentityResult> {
    // Vérifier que c'est la même seed
    const derived = deriveUnifiedIdentity(walletMnemonic);

    // Vérifier que la clé Nostr correspond
    if (derived.nostr.privkey !== nostrPrivkey) {
      throw new IdentityError(
        'La clé Nostr ne correspond pas au seed du wallet',
        'MIGRATION_KEY_MISMATCH'
      );
    }

    // Créer l'identité unifiée
    return this.createIdentity(walletMnemonic, password);
  }

  /**
   * Supprime l'identité du stockage (action irréversible).
   */
  async deleteIdentity(): Promise<void> {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    this.identity = null;
    this.isUnlocked = false;
  }

  // ─── Méthodes privées ───────────────────────────────────────────────────────

  /**
   * Chiffre une clé avec PBKDF2 + AES-GCM.
   */
  private async encryptKey(key: string, password: string): Promise<string> {
    const salt = randomBytes(32);
    const iv = randomBytes(12);

    // Dériver la clé de chiffrement avec PBKDF2
    const keyMaterial = pbkdf2(
      sha256,
      new TextEncoder().encode(password),
      salt,
      { c: PBKDF2_ITERATIONS, dkLen: 32 }
    );

    // Chiffrer avec AES-GCM
    const cipher = gcm(keyMaterial, iv);
    const ciphertext = cipher.encrypt(new TextEncoder().encode(key));

    return JSON.stringify({
      v: ENCRYPTION_VERSION,
      salt: bytesToHex(salt),
      iv: bytesToHex(iv),
      ct: bytesToHex(ciphertext),
    });
  }

  /**
   * Déchiffre une clé avec PBKDF2 + AES-GCM.
   */
  private async decryptKey(encrypted: string, password: string): Promise<string> {
    const { v, salt, iv, ct } = JSON.parse(encrypted);

    if (v !== ENCRYPTION_VERSION) {
      throw new IdentityError('Version de chiffrement non supportée', 'UNSUPPORTED_VERSION');
    }

    const saltBytes = hexToBytes(salt);
    const ivBytes = hexToBytes(iv);
    const ciphertext = hexToBytes(ct);

    // Dériver la clé de chiffrement avec PBKDF2
    const keyMaterial = pbkdf2(
      sha256,
      new TextEncoder().encode(password),
      saltBytes,
      { c: PBKDF2_ITERATIONS, dkLen: 32 }
    );

    // Déchiffrer avec AES-GCM
    try {
      const cipher = gcm(keyMaterial, ivBytes);
      const plaintext = cipher.decrypt(ciphertext);
      return new TextDecoder().decode(plaintext);
    } catch (error) {
      throw new DecryptionError();
    }
  }
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let defaultManager: UnifiedIdentityManager | null = null;

/**
 * Retourne l'instance par défaut du UnifiedIdentityManager.
 */
export function getIdentityManager(): UnifiedIdentityManager {
  if (!defaultManager) {
    defaultManager = new UnifiedIdentityManager();
  }
  return defaultManager;
}

/**
 * Réinitialise l'instance par défaut (utile pour les tests).
 */
export function resetIdentityManager(): void {
  defaultManager = null;
}
