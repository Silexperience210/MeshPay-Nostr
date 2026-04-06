/**
 * UnifiedIdentityManager - Gestionnaire d'identité unifiée
 *
 * Version corrigée - Freeze fixes v2: yield between heavy crypto ops
 */

import * as SecureStore from 'expo-secure-store';
import { InteractionManager } from 'react-native';
// @ts-ignore - subpath exports use .js extension
import { bytesToHex } from '@noble/hashes/utils.js';
import { deriveUnifiedIdentity, UnifiedIdentity, BitcoinIdentity, NostrIdentity, MeshCoreIdentity } from './Derivation';
import { HermesEngine, hermes } from '../HermesEngine';
import { EventType } from '../types';

/** Yield the JS thread so the UI can update */
const yieldThread = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const STORAGE_KEY = 'unified_identity_v1';
const ENCRYPTION_VERSION = 1;
// 100k iterations causes ~2-4s freeze per call on mobile Hermes.
// 10k is still secure for local-device encryption and keeps UI responsive.
const PBKDF2_ITERATIONS = 10_000;

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
  version: number;
  data: string;
}

export interface CreateIdentityOptions {
  mnemonic: string;
  password: string;
}

export interface PublicIdentity {
  bitcoin: BitcoinIdentity;
  nostr: { pubkey: string; npub: string };
  meshcore: { pubkey: string; nodeId: string };
}

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

export class UnifiedIdentityManager {
  private identity: UnifiedIdentity | null = null;
  private isUnlocked = false;
  private hermesEngine: HermesEngine;

  constructor(hermesEngine: HermesEngine = hermes) {
    this.hermesEngine = hermesEngine;
  }

  async createIdentity(mnemonic: string, password: string): Promise<CreateIdentityResult> {
    // Wait for any pending animations/interactions to finish before heavy crypto
    await new Promise<void>(resolve => InteractionManager.runAfterInteractions(() => resolve()));

    const identity = deriveUnifiedIdentity(mnemonic);
    await yieldThread(); // Let UI breathe after seed derivation

    const encryptedNostrPrivkey = await this.encryptKey(identity.nostr.privkey, password);
    await yieldThread(); // Let UI breathe after first PBKDF2 (100k iterations)

    const encryptedMeshcorePrivkey = await this.encryptKey(identity.meshcore.privkey, password);
    await yieldThread(); // Let UI breathe after second PBKDF2

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

    // Émission non-bloquante
    this.emitWalletInitialized(identity).catch(() => {});

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

  private async emitWalletInitialized(identity: UnifiedIdentity): Promise<void> {
    try {
      if (!this.hermesEngine.stats.isRunning) {
        await Promise.race([
          this.hermesEngine.start(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('timeout')), 3000)
          )
        ]);
      }
      
      await this.hermesEngine.emit({
        id: `wallet-${Date.now()}`,
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
    } catch {
      // Ignorer silencieusement
    }
  }

  // NOUVEAU: Méthode manquante ajoutée
  async getPublicIdentity(): Promise<PublicIdentity | null> {
    const storedJson = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!storedJson) return null;
    
    const stored: StoredIdentity = JSON.parse(storedJson);
    return {
      bitcoin: stored.bitcoin,
      nostr: { pubkey: stored.nostr.pubkey, npub: stored.nostr.npub },
      meshcore: { pubkey: stored.meshcore.pubkey, nodeId: stored.meshcore.nodeId },
    };
  }

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

  async deleteIdentity(): Promise<void> {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    this.identity = null;
    this.isUnlocked = false;
  }

  async exportBackup(password: string): Promise<string> {
    if (!this.isUnlocked || !this.identity) {
      throw new IdentityError('Identité verrouillée', 'IDENTITY_LOCKED');
    }
    const data = JSON.stringify({
      bitcoin: this.identity.bitcoin,
      nostr: this.identity.nostr,
      meshcore: this.identity.meshcore,
      metadata: this.identity.metadata,
    });
    return await this.encryptKey(data, password);
  }

  async importBackup(backupJson: string, password: string): Promise<void> {
    const decrypted = await this.decryptKey(backupJson, password);
    const data = JSON.parse(decrypted) as StoredIdentity;
    const encrypted = await this.encryptKey(JSON.stringify(data), password);
    await SecureStore.setItemAsync(STORAGE_KEY, encrypted);
    await this.unlock(password);
  }

  async migrateFromLegacy(walletMnemonic: string, _nostrPrivkey: string, password: string): Promise<void> {
    // Migration: create identity from wallet mnemonic (nostr key is re-derived)
    await this.createIdentity(walletMnemonic, password);
  }

  private async encryptKey(key: string, password: string): Promise<string> {
    // @ts-ignore
    const { pbkdf2 } = await import('@noble/hashes/pbkdf2.js');
    // @ts-ignore
    const { sha256 } = await import('@noble/hashes/sha2.js');
    // @ts-ignore
    const { gcm } = await import('@noble/ciphers/aes.js');
    // @ts-ignore
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
    // @ts-ignore
    const { pbkdf2 } = await import('@noble/hashes/pbkdf2.js');
    // @ts-ignore
    const { sha256 } = await import('@noble/hashes/sha2.js');
    // @ts-ignore
    const { gcm } = await import('@noble/ciphers/aes.js');

    const { v, salt, iv, ct } = JSON.parse(encrypted);

    if (v !== ENCRYPTION_VERSION) {
      throw new IdentityError('Version non supportée', 'UNSUPPORTED_VERSION');
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

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

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
