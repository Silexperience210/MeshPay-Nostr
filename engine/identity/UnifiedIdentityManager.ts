/**
 * UnifiedIdentityManager - Gestionnaire d'identité unifiée
 * 
 * Gère la création, le stockage sécurisé et le déverrouillage des identités
 * dérivées depuis une seed mnemonic unique.
 * 
 * Phase 4: Corrections freeze - Démarrage Hermès non bloquant
 */

import * as SecureStore from 'expo-secure-store';
// @ts-ignore - subpath exports use .js extension
import { bytesToHex } from '@noble/hashes/utils.js';
import { deriveUnifiedIdentity, UnifiedIdentity, BitcoinIdentity, NostrIdentity, MeshCoreIdentity } from './Derivation';
import { HermesEngine, hermes } from '../HermesEngine';
import { EventType } from '../types';

// ─── Constantes ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'unified_identity_v1';
const ENCRYPTION_VERSION = 1;
const PBKDF2_ITERATIONS = 100000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredIdentity {
  bitcoin: BitcoinIdentity;
  nostr: Omit<NostrIdentity, 'privkey'> & { privkey: string };
  meshcore: Omit<MeshCoreIdentity, 'privkey'> & { privkey: string };
  metadata: UnifiedIdentity['metadata'];
}

export interface CreateIdentityResult {
  mnemonic: string;
  identity: Omit<UnifiedIdentity, 'nostr' | 'meshcore'> & {
    nostr: Omit<NostrIdentity, 'privkey'>;
    meshcore: Omit<MeshCoreIdentity, 'privkey'>;
  };
}

export interface EncryptedBackup {
  version: string;
  encryptedData: string;
  createdAt: number;
  salt: string;
  iv: string;
}

export interface CreateIdentityOptions {
  strength?: 12 | 24;
  password: string;
  passphrase?: string;
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

  async createIdentity(mnemonic: string, password: string): Promise<CreateIdentityResult> {
    console.log('[UnifiedIdentityManager] === createIdentity START ===');
    
    // Dériver toutes les identités
    console.log('[UnifiedIdentityManager] Deriving identity...');
    const identity = deriveUnifiedIdentity(mnemonic);
    console.log('[UnifiedIdentityManager] Identity derived:', identity.meshcore.nodeId);

    // Chiffrer les clés privées
    console.log('[UnifiedIdentityManager] Encrypting keys...');
    const encryptedNostrPrivkey = await this.encryptKey(identity.nostr.privkey, password);
    const encryptedMeshcorePrivkey = await this.encryptKey(identity.meshcore.privkey, password);
    console.log('[UnifiedIdentityManager] Keys encrypted');

    // Créer l'identité stockable
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

    // Sauvegarder dans le stockage sécurisé (avec timeout)
    console.log('[UnifiedIdentityManager] Saving to SecureStore...');
    try {
      await Promise.race([
        SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(storedIdentity)),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('SecureStore timeout')), 5000)
        )
      ]);
      console.log('[UnifiedIdentityManager] SecureStore save complete');
    } catch (error) {
      console.error('[UnifiedIdentityManager] SecureStore failed:', error);
      throw new IdentityError('Stockage sécurisé indisponible', 'STORAGE_FAILED');
    }

    // Mettre à jour l'état interne
    this.identity = identity;
    this.isUnlocked = true;

    // Émettre un événement (NON BLOQUANT - en arrière-plan)
    console.log('[UnifiedIdentityManager] Emitting WALLET_INITIALIZED (non-blocking)...');
    this.emitWalletInitialized(identity).catch(err => {
      console.warn('[UnifiedIdentityManager] Failed to emit event:', err);
    });

    console.log('[UnifiedIdentityManager] === createIdentity END ===');

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

  // Émission d'événement non bloquante
  private async emitWalletInitialized(identity: UnifiedIdentity): Promise<void> {
    try {
      // Démarrer l'engine si nécessaire (avec timeout)
      if (!this.hermesEngine.stats.isRunning) {
        console.log('[UnifiedIdentityManager] Starting Hermes engine...');
        await Promise.race([
          this.hermesEngine.start(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Hermes start timeout')), 5000)
          )
        ]);
        console.log('[UnifiedIdentityManager] Hermes started!');
      }
      
      await this.hermesEngine.emit({
        id: `wallet-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        type: EventType.WALLET_INITIALIZED,
        transport: 'internal' as any,
        timestamp: Date.now(),
        from: identity.meshcore.nodeId,
        to: '*',
        payload: {
          bitcoinAddress: identity.bitcoin.firstAddress,
          nostrPubkey: identity.nostr.pubkey,
          meshcoreNodeId: identity.meshcore.nodeId,
        },
        meta: {},
      });
      console.log('[UnifiedIdentityManager] Event emitted successfully');
    } catch (emitError) {
      console.warn('[UnifiedIdentityManager] Failed to emit event:', emitError);
    }
  }

  // ─── Déverrouillage ─────────────────────────────────────────────────────────

  async unlock(password: string): Promise<boolean> {
    try {
      const storedJson = await SecureStore.getItemAsync(STORAGE_KEY);
      if (!storedJson) {
        throw new IdentityNotFoundError();
      }

      const stored: StoredIdentity = JSON.parse(storedJson);

      const nostrPrivkey = await this.decryptKey(stored.nostr.privkey, password);
      const meshcorePrivkey = await this.decryptKey(stored.meshcore.privkey, password);

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
      throw new DecryptionError();
    }
  }

  async hasIdentity(): Promise<boolean> {
    const stored = await SecureStore.getItemAsync(STORAGE_KEY);
    return stored !== null;
  }

  lock(): void {
    this.identity = null;
    this.isUnlocked = false;
  }

  getIdentity(): UnifiedIdentity {
    if (!this.isUnlocked || !this.identity) {
      throw new IdentityError('Identité verrouillée', 'IDENTITY_LOCKED');
    }
    return this.identity;
  }

  getIsUnlocked(): boolean {
    return this.isUnlocked;
  }

  // ─── Export/Import ──────────────────────────────────────────────────────────

  async exportBackup(password: string): Promise<string> {
    const canUnlock = await this.unlock(password);
    if (!canUnlock) {
      throw new DecryptionError();
    }

    const identity = this.getIdentity();
    const backupData = JSON.stringify(identity);
    const encrypted = await this.encryptKey(backupData, password);
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

  async importBackup(backupJson: string, password: string): Promise<void> {
    const backup: EncryptedBackup = JSON.parse(backupJson);
    const decrypted = await this.decryptKey(backup.encryptedData, password);
    const identity: UnifiedIdentity = JSON.parse(decrypted);

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

  async migrateFromLegacy(
    walletMnemonic: string,
    nostrPrivkey: string,
    password: string
  ): Promise<CreateIdentityResult> {
    const derived = deriveUnifiedIdentity(walletMnemonic);

    if (derived.nostr.privkey !== nostrPrivkey) {
      throw new IdentityError(
        'La clé Nostr ne correspond pas au seed du wallet',
        'MIGRATION_KEY_MISMATCH'
      );
    }

    return this.createIdentity(walletMnemonic, password);
  }

  async deleteIdentity(): Promise<void> {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    this.identity = null;
    this.isUnlocked = false;
  }

  // ─── Méthodes privées ───────────────────────────────────────────────────────

  private async encryptKey(key: string, password: string): Promise<string> {
    // @ts-ignore - subpath exports
    const { pbkdf2 } = await import('@noble/hashes/pbkdf2.js');
    // @ts-ignore - subpath exports
    const { sha256 } = await import('@noble/hashes/sha2.js');
    // @ts-ignore - subpath exports
    const { gcm } = await import('@noble/ciphers/aes.js');
    // @ts-ignore - subpath exports
    const { randomBytes } = await import('@noble/hashes/utils.js');

    const salt = randomBytes(32);
    const iv = randomBytes(12);

    const keyMaterial = pbkdf2(
      sha256,
      new TextEncoder().encode(password),
      salt,
      { c: PBKDF2_ITERATIONS, dkLen: 32 }
    );

    const cipher = gcm(keyMaterial, iv);
    const ciphertext = cipher.encrypt(new TextEncoder().encode(key));

    return JSON.stringify({
      v: ENCRYPTION_VERSION,
      salt: bytesToHex(salt),
      iv: bytesToHex(iv),
      ct: bytesToHex(ciphertext),
    });
  }

  private async decryptKey(encrypted: string, password: string): Promise<string> {
    // @ts-ignore - subpath exports
    const { pbkdf2 } = await import('@noble/hashes/pbkdf2.js');
    // @ts-ignore - subpath exports
    const { sha256 } = await import('@noble/hashes/sha2.js');
    // @ts-ignore - subpath exports
    const { gcm } = await import('@noble/ciphers/aes.js');

    const { v, salt, iv, ct } = JSON.parse(encrypted);

    if (v !== ENCRYPTION_VERSION) {
      throw new IdentityError('Version de chiffrement non supportée', 'UNSUPPORTED_VERSION');
    }

    const saltBytes = hexToBytes(salt);
    const ivBytes = hexToBytes(iv);
    const ciphertext = hexToBytes(ct);

    const keyMaterial = pbkdf2(
      sha256,
      new TextEncoder().encode(password),
      saltBytes,
      { c: PBKDF2_ITERATIONS, dkLen: 32 }
    );

    try {
      const decipher = gcm(keyMaterial, ivBytes);
      const plaintext = decipher.decrypt(ciphertext);
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

export function getIdentityManager(): UnifiedIdentityManager {
  if (!defaultManager) {
    defaultManager = new UnifiedIdentityManager();
  }
  return defaultManager;
}

export function resetIdentityManager(): void {
  defaultManager = null;
}
