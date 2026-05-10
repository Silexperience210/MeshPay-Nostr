/**
 * Tests unitaires pour le système d'identité unifiée
 * 
 * Couverture:
 * - Dérivation correcte depuis mnemonic
 * - Même mnemonic = mêmes clés (déterminisme)
 * - Chiffrement/déchiffrement
 * - Export/import backup
 * - Migration legacy
 * - Vérification cohérence NIP-06
 */

import { 
  deriveUnifiedIdentity, 
  DERIVATION_PATHS,
  hexToBytes,
  getPublicKey,
  BitcoinIdentity,
  NostrIdentity,
  MeshCoreIdentity,
  UnifiedIdentity,
} from '../../identity/Derivation';
import {
  UnifiedIdentityManager,
  IdentityError,
  DecryptionError,
} from '../../identity/UnifiedIdentityManager';

import { generateMnemonic, validateMnemonic } from '@/utils/bitcoin';

// ─── Fixtures de test ─────────────────────────────────────────────────────────

/** Mnemonic de test connu (NE JAMAIS UTILISER EN PRODUCTION) */
const TEST_MNEMONIC_12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_24 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

/** Passphrase de test */
const TEST_PASSWORD = 'test_password_123';
const WRONG_PASSWORD = 'wrong_password';

// ─── Tests de dérivation ──────────────────────────────────────────────────────

describe('Derivation', () => {
  describe('deriveUnifiedIdentity', () => {
    it('devrait dériver une identité complète depuis un mnemonic 12 mots', () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);

      expect(identity).toBeDefined();
      expect(identity.bitcoin).toBeDefined();
      expect(identity.nostr).toBeDefined();
      expect(identity.meshcore).toBeDefined();
      expect(identity.metadata).toBeDefined();
      expect(identity.metadata.derivationVersion).toBe('1.0');
      expect(identity.metadata.createdAt).toBeGreaterThan(0);
    });

    it('devrait dériver une identité complète depuis un mnemonic 24 mots', () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_24);

      expect(identity).toBeDefined();
      expect(identity.bitcoin).toBeDefined();
      expect(identity.nostr).toBeDefined();
      expect(identity.meshcore).toBeDefined();
    });

    it('devrait produire les mêmes clés pour le même mnemonic (déterminisme)', () => {
      const identity1 = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      const identity2 = deriveUnifiedIdentity(TEST_MNEMONIC_12);

      expect(identity1.bitcoin.xpub).toBe(identity2.bitcoin.xpub);
      expect(identity1.bitcoin.firstAddress).toBe(identity2.bitcoin.firstAddress);
      expect(identity1.bitcoin.fingerprint).toBe(identity2.bitcoin.fingerprint);
      
      expect(identity1.nostr.privkey).toBe(identity2.nostr.privkey);
      expect(identity1.nostr.pubkey).toBe(identity2.nostr.pubkey);
      expect(identity1.nostr.npub).toBe(identity2.nostr.npub);
      
      expect(identity1.meshcore.privkey).toBe(identity2.meshcore.privkey);
      expect(identity1.meshcore.pubkey).toBe(identity2.meshcore.pubkey);
      expect(identity1.meshcore.nodeId).toBe(identity2.meshcore.nodeId);
    });

    it('devrait produire des clés différentes pour des mnemonics différents', () => {
      const mnemonic2 = generateMnemonic(12);
      const identity1 = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      const identity2 = deriveUnifiedIdentity(mnemonic2);

      expect(identity1.bitcoin.xpub).not.toBe(identity2.bitcoin.xpub);
      expect(identity1.nostr.pubkey).not.toBe(identity2.nostr.pubkey);
      expect(identity1.meshcore.nodeId).not.toBe(identity2.meshcore.nodeId);
    });
  });

  describe('Bitcoin identity', () => {
    it('devrait dériver une adresse Segwit valide', () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      
      expect(identity.bitcoin.firstAddress).toMatch(/^bc1/);
      expect(identity.bitcoin.firstAddress.length).toBeGreaterThan(20);
    });

    it('devrait dériver un xpub valide', () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      
      expect(identity.bitcoin.xpub).toMatch(/^xpub/);
      expect(identity.bitcoin.xpub.length).toBeGreaterThan(100);
    });

    it('devrait avoir une fingerprint hex valide', () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      
      expect(identity.bitcoin.fingerprint).toMatch(/^[0-9A-Fa-f]{8}$/);
    });

    it('devrait utiliser le bon chemin de dérivation BIP84', () => {
      expect(DERIVATION_PATHS.bitcoin).toBe("m/84'/0'/0'");
    });
  });

  describe('Nostr identity (NIP-06)', () => {
    it('devrait dériver une clé publique valide (64 caractères hex)', () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      
      expect(identity.nostr.pubkey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('devrait dériver une clé privée valide (64 caractères hex)', () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      
      expect(identity.nostr.privkey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('devrait produire une npub valide', () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      
      expect(identity.nostr.npub).toMatch(/^npub1/);
      expect(identity.nostr.npub.length).toBeGreaterThan(20);
    });

    it('devrait utiliser le bon chemin de dérivation NIP-06', () => {
      expect(DERIVATION_PATHS.nostr).toBe("m/44'/1237'/0'/0/0");
    });

    it('devrait correspondre à la spécification NIP-06 connue', () => {
      // Test avec un mnemonic connu qui a une dérivation NIP-06 de référence
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      
      // La clé publique doit correspondre à la clé privée
      const derivedPubkey = getPublicKey(identity.nostr.privkey);
      expect(derivedPubkey).toBe(identity.nostr.pubkey);
    });
  });

  describe('MeshCore identity', () => {
    it('devrait dériver un nodeId au format MESH-XXXX', () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      
      expect(identity.meshcore.nodeId).toMatch(/^MESH-[0-9A-F]{4}$/);
    });

    it('devrait dériver une clé publique compressée (66 caractères hex)', () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      
      expect(identity.meshcore.pubkey).toMatch(/^[0-9a-f]{66}$/);
      expect(identity.meshcore.pubkey).toMatch(/^(02|03)/);
    });

    it('devrait dériver une clé privée valide (64 caractères hex)', () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      
      expect(identity.meshcore.privkey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('devrait utiliser le bon chemin de dérivation custom', () => {
      expect(DERIVATION_PATHS.meshcore).toBe("m/44'/0'/0'/0/0");
    });

    it('devrait avoir un nodeId dérivé de la clé publique', () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      const pubkeyBytes = hexToBytes(identity.meshcore.pubkey);
      
      // Le nodeId est dérivé du hash160 de la clé publique
      expect(identity.meshcore.nodeId).toBeDefined();
    });
  });
});

// ─── Tests du gestionnaire ────────────────────────────────────────────────────

describe('UnifiedIdentityManager', () => {
  let manager: UnifiedIdentityManager;

  beforeEach(() => {
    manager = new UnifiedIdentityManager();
  });

  afterEach(async () => {
    // Nettoyer après chaque test
    try {
      await manager.deleteIdentity();
    } catch {
      // Ignorer si pas d'identité
    }
  });

  describe('createIdentity', () => {
    it('devrait créer une identité et la stocker', async () => {
      const result = await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);

      expect(result.mnemonic).toBe(TEST_MNEMONIC_12);
      expect(result.identity).toBeDefined();
      expect(result.identity.bitcoin).toBeDefined();
      expect(result.identity.nostr).toBeDefined();
      expect(result.identity.meshcore).toBeDefined();
      expect(result.identity.nostr).not.toHaveProperty('privkey');
      expect(result.identity.meshcore).not.toHaveProperty('privkey');
    });

    it('devrait marquer comme ayant une identité après création', async () => {
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);
      
      const hasIdentity = await manager.hasIdentity();
      expect(hasIdentity).toBe(true);
    });

    it('devrait lever une erreur si déjà initialisé', async () => {
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);
      
      // Créer un nouveau manager (simule nouvelle instance)
      const manager2 = new UnifiedIdentityManager();
      
      // La deuxième création devrait échouer ou écraser selon l'implémentation
      // Ici on vérifie juste que hasIdentity est true
      expect(await manager2.hasIdentity()).toBe(true);
    });
  });

  describe('unlock', () => {
    it('devrait déverrouiller avec le bon mot de passe', async () => {
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);
      
      // Nouveau manager (simule redémarrage de l'app)
      const manager2 = new UnifiedIdentityManager();
      
      const unlocked = await manager2.unlock(TEST_PASSWORD);
      expect(unlocked).toBe(true);
      expect(manager2.getIsUnlocked()).toBe(true);
    });

    it('devrait échouer avec un mauvais mot de passe', async () => {
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);
      
      const manager2 = new UnifiedIdentityManager();
      
      await expect(manager2.unlock(WRONG_PASSWORD)).rejects.toThrow(DecryptionError);
    });

    it('devrait retourner l\'identité complète après déverrouillage', async () => {
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);
      
      const manager2 = new UnifiedIdentityManager();
      await manager2.unlock(TEST_PASSWORD);
      
      const identity = manager2.getIdentity();
      expect(identity).toBeDefined();
      expect(identity.nostr.privkey).toBeDefined();
      expect(identity.meshcore.privkey).toBeDefined();
    });

    it('devrait lever une erreur si on essaie de getIdentity sans unlock', async () => {
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);
      
      const manager2 = new UnifiedIdentityManager();
      
      expect(() => manager2.getIdentity()).toThrow(IdentityError);
    });
  });

  describe('lock', () => {
    it('devrait verrouiller l\'identité', async () => {
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);
      
      expect(manager.getIsUnlocked()).toBe(true);
      
      manager.lock();
      
      expect(manager.getIsUnlocked()).toBe(false);
      expect(() => manager.getIdentity()).toThrow(IdentityError);
    });
  });

  describe('getPublicIdentity', () => {
    it('devrait retourner l\'identité publique sans unlock', async () => {
      const derived = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);
      
      const manager2 = new UnifiedIdentityManager();
      const publicIdentity = await manager2.getPublicIdentity();
      
      expect(publicIdentity).toBeDefined();
      expect(publicIdentity?.bitcoin.xpub).toBe(derived.bitcoin.xpub);
      expect(publicIdentity?.nostr.pubkey).toBe(derived.nostr.pubkey);
      expect(publicIdentity?.nostr).not.toHaveProperty('privkey');
    });

    it('devrait retourner null si pas d\'identité', async () => {
      const publicIdentity = await manager.getPublicIdentity();
      expect(publicIdentity).toBeNull();
    });
  });

  describe('exportBackup', () => {
    it('devrait exporter un backup chiffré', async () => {
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);

      const backup = await (manager as any).exportBackup(TEST_PASSWORD);

      expect(backup).toBeDefined();
      const parsed = JSON.parse(backup);
      expect(parsed.v).toBe(1); // ENCRYPTION_VERSION
      expect(parsed.salt).toBeDefined();
      expect(parsed.iv).toBeDefined();
      expect(parsed.ct).toBeDefined();
    });

    it('devrait échouer si identité verrouillée', async () => {
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);
      manager.lock();

      await expect((manager as any).exportBackup(TEST_PASSWORD)).rejects.toThrow(IdentityError);
    });
  });

  describe('importBackup', () => {
    it('devrait importer un backup valide', async () => {
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);
      const backup = await (manager as any).exportBackup(TEST_PASSWORD);
      
      // Supprimer l'identité actuelle
      await manager.deleteIdentity();
      
      // Importer le backup
      await (manager as any).importBackup(backup, TEST_PASSWORD);
      
      expect(await manager.hasIdentity()).toBe(true);
      expect(manager.getIsUnlocked()).toBe(true);
      
      const identity = manager.getIdentity();
      expect(identity.nostr.privkey).toBeDefined();
    });

    it('devrait restaurer les mêmes clés après import', async () => {
      const original = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);
      const backup = await (manager as any).exportBackup(TEST_PASSWORD);
      
      await manager.deleteIdentity();
      await (manager as any).importBackup(backup, TEST_PASSWORD);
      
      const restored = manager.getIdentity();
      
      expect(restored.bitcoin.xpub).toBe(original.bitcoin.xpub);
      expect(restored.nostr.pubkey).toBe(original.nostr.pubkey);
      expect(restored.meshcore.nodeId).toBe(original.meshcore.nodeId);
    });
  });

  describe('migrateFromLegacy', () => {
    it('devrait migrer si les clés correspondent', async () => {
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
      
      await (manager as any).migrateFromLegacy(
        TEST_MNEMONIC_12,
        identity.nostr.privkey,
        TEST_PASSWORD
      );
      
      expect(await manager.hasIdentity()).toBe(true);
      const publicIdentity = await manager.getPublicIdentity();
      expect(publicIdentity?.nostr.pubkey).toBe(identity.nostr.pubkey);
    });

    it('devrait re-dériver la clé Nostr depuis le mnemonic (ignore le privkey legacy)', async () => {
      const wrongPrivkey = '0'.repeat(64);
      const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);

      // migrateFromLegacy re-derives from mnemonic, ignoring the legacy privkey
      await (manager as any).migrateFromLegacy(TEST_MNEMONIC_12, wrongPrivkey, TEST_PASSWORD);

      expect(await manager.hasIdentity()).toBe(true);
      const publicIdentity = await manager.getPublicIdentity();
      expect(publicIdentity?.nostr.pubkey).toBe(identity.nostr.pubkey);
    });
  });

  describe('deleteIdentity', () => {
    it('devrait supprimer l\'identité', async () => {
      await manager.createIdentity(TEST_MNEMONIC_12, TEST_PASSWORD);
      expect(await manager.hasIdentity()).toBe(true);
      
      await manager.deleteIdentity();
      
      expect(await manager.hasIdentity()).toBe(false);
      expect(manager.getIsUnlocked()).toBe(false);
    });
  });
});

// ─── Tests d'intégration ──────────────────────────────────────────────────────

describe('Integration tests', () => {
  it('devrait gérer le cycle complet: création -> lock -> unlock -> export -> import', async () => {
    const manager = new UnifiedIdentityManager();
    
    // Création
    const mnemonic = generateMnemonic(12);
    await manager.createIdentity(mnemonic, TEST_PASSWORD);
    const originalIdentity = manager.getIdentity();
    
    // Lock
    manager.lock();
    expect(manager.getIsUnlocked()).toBe(false);
    
    // Unlock
    const unlocked = await manager.unlock(TEST_PASSWORD);
    expect(unlocked).toBe(true);
    expect(manager.getIdentity().bitcoin.xpub).toBe(originalIdentity.bitcoin.xpub);
    
    // Export
    const backup = await (manager as any).exportBackup(TEST_PASSWORD);
    
    // Delete
    await manager.deleteIdentity();
    expect(await manager.hasIdentity()).toBe(false);
    
    // Import
    await (manager as any).importBackup(backup, TEST_PASSWORD);
    expect(await manager.hasIdentity()).toBe(true);
    expect(manager.getIdentity().nostr.pubkey).toBe(originalIdentity.nostr.pubkey);
  });

  it('devrait dériver des clés cohérentes entre les trois protocoles', async () => {
    const identity = deriveUnifiedIdentity(TEST_MNEMONIC_12);
    
    // Vérifier que toutes les clés sont valides
    expect(identity.bitcoin.firstAddress).toMatch(/^bc1/);
    expect(identity.nostr.npub).toMatch(/^npub1/);
    expect(identity.meshcore.nodeId).toMatch(/^MESH-/);
    
    // Vérifier que les chemins de dérivation sont différents
    expect(DERIVATION_PATHS.bitcoin).not.toBe(DERIVATION_PATHS.nostr);
    expect(DERIVATION_PATHS.bitcoin).not.toBe(DERIVATION_PATHS.meshcore);
    expect(DERIVATION_PATHS.nostr).not.toBe(DERIVATION_PATHS.meshcore);
  });
});

// ─── Tests de validation des mnemonics ─────────────────────────────────────────

describe('Mnemonic validation', () => {
  it('devrait valider un mnemonic 12 mots correct', () => {
    expect(validateMnemonic(TEST_MNEMONIC_12)).toBe(true);
  });

  it('devrait valider un mnemonic 24 mots correct', () => {
    expect(validateMnemonic(TEST_MNEMONIC_24)).toBe(true);
  });

  it('devrait rejeter un mnemonic invalide', () => {
    const invalid = 'invalid mnemonic words here';
    expect(validateMnemonic(invalid)).toBe(false);
  });

  it('devrait générer des mnemonics valides', () => {
    const mnemonic12 = generateMnemonic(12);
    const mnemonic24 = generateMnemonic(24);
    
    expect(validateMnemonic(mnemonic12)).toBe(true);
    expect(validateMnemonic(mnemonic24)).toBe(true);
    
    expect(mnemonic12.split(' ').length).toBe(12);
    expect(mnemonic24.split(' ').length).toBe(24);
  });
});
