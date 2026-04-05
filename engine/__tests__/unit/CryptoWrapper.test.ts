/**
 * @fileoverview Tests unitaires pour CryptoWrapper
 * 
 * @module engine/__tests__/unit/CryptoWrapper
 * @version 1.0.0
 */

import {
  NobleCryptoWrapper,
  cryptoWrapper,
  getCryptoWrapper,
  randomBytes,
  timingSafeEqual,
  isValidKey,
  AES_KEY_SIZE,
  AES_IV_SIZE,
  AES_TAG_SIZE,
  PBKDF2_ITERATIONS,
  PBKDF2_SALT_SIZE,
} from '../../utils/CryptoWrapper';

describe('CryptoWrapper', () => {
  let wrapper: NobleCryptoWrapper;

  beforeEach(() => {
    wrapper = new NobleCryptoWrapper();
  });

  // ============================================================================
  // Tests des fonctions utilitaires
  // ============================================================================

  describe('randomBytes', () => {
    it('should generate random bytes of specified size', () => {
      const bytes = randomBytes(32);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBe(32);
    });

    it('should generate different values on each call', () => {
      const bytes1 = randomBytes(32);
      const bytes2 = randomBytes(32);
      expect(bytes1).not.toEqual(bytes2);
    });

    it('should handle zero size', () => {
      const bytes = randomBytes(0);
      expect(bytes.length).toBe(0);
    });

    it('should throw on negative size', () => {
      expect(() => randomBytes(-1)).toThrow('randomBytes: size must be non-negative');
    });

    it('should throw on size too large', () => {
      expect(() => randomBytes(65537)).toThrow('randomBytes: size exceeds maximum');
    });
  });

  describe('timingSafeEqual', () => {
    it('should return true for equal arrays', () => {
      const a = new Uint8Array([1, 2, 3, 4]);
      const b = new Uint8Array([1, 2, 3, 4]);
      expect(timingSafeEqual(a, b)).toBe(true);
    });

    it('should return false for different arrays', () => {
      const a = new Uint8Array([1, 2, 3, 4]);
      const b = new Uint8Array([1, 2, 3, 5]);
      expect(timingSafeEqual(a, b)).toBe(false);
    });

    it('should return false for different lengths', () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([1, 2, 3, 4]);
      expect(timingSafeEqual(a, b)).toBe(false);
    });

    it('should return true for empty arrays', () => {
      const a = new Uint8Array(0);
      const b = new Uint8Array(0);
      expect(timingSafeEqual(a, b)).toBe(true);
    });
  });

  describe('isValidKey', () => {
    it('should return true for valid key', () => {
      const key = randomBytes(AES_KEY_SIZE);
      expect(isValidKey(key)).toBe(true);
    });

    it('should return false for wrong size', () => {
      const key = randomBytes(16);
      expect(isValidKey(key)).toBe(false);
    });

    it('should return false for all zeros', () => {
      const key = new Uint8Array(AES_KEY_SIZE);
      expect(isValidKey(key)).toBe(false);
    });

    it('should return false for non-Uint8Array', () => {
      expect(isValidKey([1, 2, 3] as any)).toBe(false);
    });

    it('should accept custom expected size', () => {
      const key = randomBytes(16);
      expect(isValidKey(key, 16)).toBe(true);
    });
  });

  // ============================================================================
  // Tests de chiffrement symétrique (AES-GCM)
  // ============================================================================

  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt successfully', async () => {
      const key = await wrapper.generateKey();
      const plaintext = 'Hello, World!';

      const encrypted = await wrapper.encrypt(plaintext, key);
      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('tag');

      const decrypted = await wrapper.decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt empty string', async () => {
      const key = await wrapper.generateKey();
      const plaintext = '';

      const encrypted = await wrapper.encrypt(plaintext, key);
      const decrypted = await wrapper.decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt unicode text', async () => {
      const key = await wrapper.generateKey();
      const plaintext = '🎉 Unicode test: éèàùñ 中文 العربية';

      const encrypted = await wrapper.encrypt(plaintext, key);
      const decrypted = await wrapper.decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt large text', async () => {
      const key = await wrapper.generateKey();
      const plaintext = 'A'.repeat(10000);

      const encrypted = await wrapper.encrypt(plaintext, key);
      const decrypted = await wrapper.decrypt(encrypted, key);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertexts for same plaintext (random IV)', async () => {
      const key = await wrapper.generateKey();
      const plaintext = 'Test message';

      const encrypted1 = await wrapper.encrypt(plaintext, key);
      const encrypted2 = await wrapper.encrypt(plaintext, key);

      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
    });

    it('should fail with wrong key', async () => {
      const key = await wrapper.generateKey();
      const wrongKey = await wrapper.generateKey();
      const plaintext = 'Test message';

      const encrypted = await wrapper.encrypt(plaintext, key);
      
      await expect(wrapper.decrypt(encrypted, wrongKey)).rejects.toThrow('Decryption failed');
    });

    it('should fail with corrupted ciphertext', async () => {
      const key = await wrapper.generateKey();
      const plaintext = 'Test message';

      const encrypted = await wrapper.encrypt(plaintext, key);
      
      // Corrompre le ciphertext
      const corruptedCiphertext = encrypted.ciphertext.slice(0, -2) + '00';
      
      await expect(wrapper.decrypt(
        { ...encrypted, ciphertext: corruptedCiphertext },
        key
      )).rejects.toThrow('Decryption failed');
    });

    it('should fail with corrupted tag', async () => {
      const key = await wrapper.generateKey();
      const plaintext = 'Test message';

      const encrypted = await wrapper.encrypt(plaintext, key);
      
      // Corrompre le tag
      const corruptedTag = encrypted.tag.slice(0, -2) + '00';
      
      await expect(wrapper.decrypt(
        { ...encrypted, tag: corruptedTag },
        key
      )).rejects.toThrow('Decryption failed');
    });

    it('should fail with invalid key size', async () => {
      const key = randomBytes(16);
      await expect(wrapper.encrypt('test', key)).rejects.toThrow('Encryption key must be 32 bytes');
    });

    it('should fail with all-zeros key', async () => {
      const key = new Uint8Array(AES_KEY_SIZE);
      await expect(wrapper.encrypt('test', key)).rejects.toThrow('Encryption key cannot be all zeros');
    });

    it('should fail with non-Uint8Array key', async () => {
      await expect(wrapper.encrypt('test', [1, 2, 3] as any)).rejects.toThrow('Encryption key must be a Uint8Array');
    });
  });

  // ============================================================================
  // Tests de chiffrement asymétrique (ECIES)
  // ============================================================================

  describe('encryptAsymmetric/decryptAsymmetric', () => {
    let keyPair: { privateKey: Uint8Array; publicKey: Uint8Array };

    beforeEach(() => {
      const privateKey = secp256k1.utils.randomPrivateKey();
      const publicKey = secp256k1.getPublicKey(privateKey, true);
      keyPair = { privateKey, publicKey };
    });

    it('should encrypt and decrypt asymmetrically', async () => {
      const plaintext = 'Hello, Asymmetric World!';

      const encrypted = await wrapper.encryptAsymmetric(plaintext, keyPair.publicKey);
      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('tag');

      const decrypted = await wrapper.decryptAsymmetric(encrypted, keyPair.privateKey);
      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt unicode text', async () => {
      const plaintext = '🎉 ECIES test: éèàùñ 中文';

      const encrypted = await wrapper.encryptAsymmetric(plaintext, keyPair.publicKey);
      const decrypted = await wrapper.decryptAsymmetric(encrypted, keyPair.privateKey);
      expect(decrypted).toBe(plaintext);
    });

    it('should produce different ciphertexts for same plaintext', async () => {
      const plaintext = 'Test message';

      const encrypted1 = await wrapper.encryptAsymmetric(plaintext, keyPair.publicKey);
      const encrypted2 = await wrapper.encryptAsymmetric(plaintext, keyPair.publicKey);

      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
    });

    it('should fail with wrong private key', async () => {
      const wrongPrivateKey = secp256k1.utils.randomPrivateKey();
      const plaintext = 'Test message';

      const encrypted = await wrapper.encryptAsymmetric(plaintext, keyPair.publicKey);
      
      await expect(wrapper.decryptAsymmetric(encrypted, wrongPrivateKey))
        .rejects.toThrow('Asymmetric decryption failed');
    });

    it('should fail with corrupted ciphertext', async () => {
      const plaintext = 'Test message';

      const encrypted = await wrapper.encryptAsymmetric(plaintext, keyPair.publicKey);
      
      // Corrompre le ciphertext (après la clé publique éphémère)
      const corruptedCiphertext = encrypted.ciphertext.slice(0, -4) + '0000';
      
      await expect(wrapper.decryptAsymmetric(
        { ...encrypted, ciphertext: corruptedCiphertext },
        keyPair.privateKey
      )).rejects.toThrow('Asymmetric decryption failed');
    });

    it('should fail with invalid private key', async () => {
      const invalidPrivateKey = new Uint8Array(32);
      const plaintext = 'Test message';

      const encrypted = await wrapper.encryptAsymmetric(plaintext, keyPair.publicKey);
      
      await expect(wrapper.decryptAsymmetric(encrypted, invalidPrivateKey))
        .rejects.toThrow('cannot be all zeros');
    });
  });

  // ============================================================================
  // Tests HMAC
  // ============================================================================

  describe('sign/verify', () => {
    it('should sign and verify successfully', async () => {
      const key = randomBytes(32);
      const data = 'Message to sign';

      const signature = await wrapper.sign(data, key);
      expect(typeof signature).toBe('string');
      expect(signature.length).toBe(64); // SHA256 = 32 bytes = 64 hex chars

      const isValid = await wrapper.verify(data, signature, key);
      expect(isValid).toBe(true);
    });

    it('should reject wrong signature', async () => {
      const key = randomBytes(32);
      const data = 'Message to sign';
      const wrongData = 'Wrong message';

      const signature = await wrapper.sign(data, key);
      const isValid = await wrapper.verify(wrongData, signature, key);
      expect(isValid).toBe(false);
    });

    it('should reject with wrong key', async () => {
      const key = randomBytes(32);
      const wrongKey = randomBytes(32);
      const data = 'Message to sign';

      const signature = await wrapper.sign(data, key);
      const isValid = await wrapper.verify(data, signature, wrongKey);
      expect(isValid).toBe(false);
    });

    it('should produce different signatures for different data', async () => {
      const key = randomBytes(32);

      const sig1 = await wrapper.sign('Message 1', key);
      const sig2 = await wrapper.sign('Message 2', key);

      expect(sig1).not.toBe(sig2);
    });

    it('should fail with empty key', async () => {
      await expect(wrapper.sign('test', new Uint8Array(0)))
        .rejects.toThrow('Key must be a non-empty Uint8Array');
    });

    it('should fail with non-string data', async () => {
      const key = randomBytes(32);
      await expect(wrapper.sign(123 as any, key))
        .rejects.toThrow('Data must be a string');
    });

    it('should handle unicode data', async () => {
      const key = randomBytes(32);
      const data = '🎉 Unicode: éèàùñ';

      const signature = await wrapper.sign(data, key);
      const isValid = await wrapper.verify(data, signature, key);
      expect(isValid).toBe(true);
    });
  });

  // ============================================================================
  // Tests SHA256
  // ============================================================================

  describe('sha256', () => {
    it('should hash string data', async () => {
      const data = 'Hello, World!';
      const hash = await wrapper.sha256(data);

      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32); // SHA256 = 256 bits = 32 bytes
    });

    it('should hash bytes data', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const hash = await wrapper.sha256(data);

      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32);
    });

    it('should produce deterministic hashes', async () => {
      const data = 'Test data';

      const hash1 = await wrapper.sha256(data);
      const hash2 = await wrapper.sha256(data);

      expect(hash1).toEqual(hash2);
    });

    it('should produce different hashes for different data', async () => {
      const hash1 = await wrapper.sha256('Data 1');
      const hash2 = await wrapper.sha256('Data 2');

      expect(hash1).not.toEqual(hash2);
    });

    it('should handle empty string', async () => {
      const hash = await wrapper.sha256('');
      expect(hash.length).toBe(32);
    });

    it('should handle unicode', async () => {
      const hash = await wrapper.sha256('🎉 Unicode: éèàùñ');
      expect(hash.length).toBe(32);
    });
  });

  // ============================================================================
  // Tests hashPassword
  // ============================================================================

  describe('hashPassword', () => {
    it('should hash password with generated salt', async () => {
      const password = 'mySecretPassword';
      const result = await wrapper.hashPassword(password);

      expect(result).toHaveProperty('hash');
      expect(result).toHaveProperty('salt');
      expect(result.hash).toBeInstanceOf(Uint8Array);
      expect(result.salt).toBeInstanceOf(Uint8Array);
      expect(result.hash.length).toBe(32);
      expect(result.salt.length).toBe(PBKDF2_SALT_SIZE);
    });

    it('should hash password with provided salt', async () => {
      const password = 'mySecretPassword';
      const salt = randomBytes(PBKDF2_SALT_SIZE);

      const result = await wrapper.hashPassword(password, salt);
      expect(result.salt).toEqual(salt);
    });

    it('should produce different hashes for same password with different salts', async () => {
      const password = 'mySecretPassword';

      const result1 = await wrapper.hashPassword(password);
      const result2 = await wrapper.hashPassword(password);

      expect(result1.hash).not.toEqual(result2.hash);
      expect(result1.salt).not.toEqual(result2.salt);
    });

    it('should produce same hash with same password and salt', async () => {
      const password = 'mySecretPassword';
      const salt = randomBytes(PBKDF2_SALT_SIZE);

      const result1 = await wrapper.hashPassword(password, salt);
      const result2 = await wrapper.hashPassword(password, salt);

      expect(result1.hash).toEqual(result2.hash);
    });

    it('should fail with empty password', async () => {
      await expect(wrapper.hashPassword(''))
        .rejects.toThrow('Password must be a non-empty string');
    });

    it('should fail with non-string password', async () => {
      await expect(wrapper.hashPassword(123 as any))
        .rejects.toThrow('Password must be a non-empty string');
    });
  });

  // ============================================================================
  // Tests deriveKey
  // ============================================================================

  describe('deriveKey', () => {
    it('should derive key with default iterations', async () => {
      const password = 'password';
      const salt = randomBytes(PBKDF2_SALT_SIZE);

      const key = await wrapper.deriveKey(password, salt);
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('should derive key with custom iterations', async () => {
      const password = 'password';
      const salt = randomBytes(PBKDF2_SALT_SIZE);
      const iterations = 5000;

      const key = await wrapper.deriveKey(password, salt, iterations);
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('should produce deterministic keys', async () => {
      const password = 'password';
      const salt = randomBytes(PBKDF2_SALT_SIZE);

      const key1 = await wrapper.deriveKey(password, salt);
      const key2 = await wrapper.deriveKey(password, salt);

      expect(key1).toEqual(key2);
    });

    it('should produce different keys with different salts', async () => {
      const password = 'password';
      const salt1 = randomBytes(PBKDF2_SALT_SIZE);
      const salt2 = randomBytes(PBKDF2_SALT_SIZE);

      const key1 = await wrapper.deriveKey(password, salt1);
      const key2 = await wrapper.deriveKey(password, salt2);

      expect(key1).not.toEqual(key2);
    });

    it('should produce different keys with different passwords', async () => {
      const salt = randomBytes(PBKDF2_SALT_SIZE);

      const key1 = await wrapper.deriveKey('password1', salt);
      const key2 = await wrapper.deriveKey('password2', salt);

      expect(key1).not.toEqual(key2);
    });

    it('should fail with too few iterations', async () => {
      const password = 'password';
      const salt = randomBytes(PBKDF2_SALT_SIZE);

      await expect(wrapper.deriveKey(password, salt, 999))
        .rejects.toThrow('Iterations must be at least 1000');
    });

    it('should fail with empty salt', async () => {
      await expect(wrapper.deriveKey('password', new Uint8Array(0)))
        .rejects.toThrow('Salt must be a non-empty Uint8Array');
    });

    it('should fail with non-Uint8Array salt', async () => {
      await expect(wrapper.deriveKey('password', [1, 2, 3] as any))
        .rejects.toThrow('Salt must be a non-empty Uint8Array');
    });
  });

  // ============================================================================
  // Tests generateKey
  // ============================================================================

  describe('generateKey', () => {
    it('should generate 32-byte key', async () => {
      const key = await wrapper.generateKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(AES_KEY_SIZE);
    });

    it('should generate different keys each time', async () => {
      const key1 = await wrapper.generateKey();
      const key2 = await wrapper.generateKey();

      expect(key1).not.toEqual(key2);
    });

    it('should generate valid keys', async () => {
      const key = await wrapper.generateKey();
      expect(isValidKey(key)).toBe(true);
    });
  });

  // ============================================================================
  // Tests d'encodage
  // ============================================================================

  describe('Encoding', () => {
    describe('bytesToHex', () => {
      it('should convert bytes to hex', () => {
        const bytes = new Uint8Array([0, 1, 255, 16]);
        const hex = wrapper.bytesToHex(bytes);
        expect(hex).toBe('0001ff10');
      });

      it('should pad single hex digits', () => {
        const bytes = new Uint8Array([0, 1, 2]);
        const hex = wrapper.bytesToHex(bytes);
        expect(hex).toBe('000102');
      });

      it('should fail with non-Uint8Array', () => {
        expect(() => wrapper.bytesToHex([1, 2, 3] as any))
          .toThrow('Input must be a Uint8Array');
      });
    });

    describe('hexToBytes', () => {
      it('should convert hex to bytes', () => {
        const hex = '0001ff10';
        const bytes = wrapper.hexToBytes(hex);
        expect(bytes).toEqual(new Uint8Array([0, 1, 255, 16]));
      });

      it('should handle uppercase', () => {
        const hex = '00FF';
        const bytes = wrapper.hexToBytes(hex);
        expect(bytes).toEqual(new Uint8Array([0, 255]));
      });

      it('should fail with odd length', () => {
        expect(() => wrapper.hexToBytes('abc'))
          .toThrow('Hex string must have an even length');
      });

      it('should fail with invalid characters', () => {
        expect(() => wrapper.hexToBytes('zzzz'))
          .toThrow('Hex string contains invalid characters');
      });

      it('should fail with non-string', () => {
        expect(() => wrapper.hexToBytes(123 as any))
          .toThrow('Input must be a string');
      });
    });

    describe('utf8ToBytes', () => {
      it('should convert string to bytes', () => {
        const str = 'Hello';
        const bytes = wrapper.utf8ToBytes(str);
        expect(bytes).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
      });

      it('should handle unicode', () => {
        const str = '🎉';
        const bytes = wrapper.utf8ToBytes(str);
        expect(bytes).toEqual(new Uint8Array([0xf0, 0x9f, 0x8e, 0x89]));
      });

      it('should fail with non-string', () => {
        expect(() => wrapper.utf8ToBytes(123 as any))
          .toThrow('Input must be a string');
      });
    });

    describe('bytesToUtf8', () => {
      it('should convert bytes to string', () => {
        const bytes = new Uint8Array([72, 101, 108, 108, 111]);
        const str = wrapper.bytesToUtf8(bytes);
        expect(str).toBe('Hello');
      });

      it('should handle unicode', () => {
        const bytes = new Uint8Array([0xf0, 0x9f, 0x8e, 0x89]);
        const str = wrapper.bytesToUtf8(bytes);
        expect(str).toBe('🎉');
      });

      it('should fail with invalid UTF-8', () => {
        const bytes = new Uint8Array([0xff, 0xfe]);
        expect(() => wrapper.bytesToUtf8(bytes))
          .toThrow('Invalid UTF-8 sequence');
      });

      it('should fail with non-Uint8Array', () => {
        expect(() => wrapper.bytesToUtf8([1, 2, 3] as any))
          .toThrow('Input must be a Uint8Array');
      });
    });

    describe('roundtrip encoding', () => {
      it('should roundtrip hex conversion', () => {
        const original = new Uint8Array([0, 1, 255, 128, 64]);
        const hex = wrapper.bytesToHex(original);
        const recovered = wrapper.hexToBytes(hex);
        expect(recovered).toEqual(original);
      });

      it('should roundtrip UTF-8 conversion', () => {
        const original = '🎉 Unicode: éèàùñ 中文';
        const bytes = wrapper.utf8ToBytes(original);
        const recovered = wrapper.bytesToUtf8(bytes);
        expect(recovered).toBe(original);
      });
    });
  });

  // ============================================================================
  // Tests du singleton
  // ============================================================================

  describe('Singleton', () => {
    it('should export singleton instance', () => {
      expect(cryptoWrapper).toBeInstanceOf(NobleCryptoWrapper);
    });

    it('should return same instance from getCryptoWrapper', () => {
      const instance1 = getCryptoWrapper();
      const instance2 = getCryptoWrapper();
      expect(instance1).toBe(instance2);
      expect(instance1).toBe(cryptoWrapper);
    });
  });

  // ============================================================================
  // Tests des cas d'erreur
  // ============================================================================

  describe('Error cases', () => {
    it('should fail decrypt with invalid payload format', async () => {
      const key = await wrapper.generateKey();
      
      await expect(wrapper.decrypt(null as any, key))
        .rejects.toThrow('Invalid payload');
      
      await expect(wrapper.decrypt({} as any, key))
        .rejects.toThrow('Invalid payload');
      
      await expect(wrapper.decrypt({ ciphertext: 'test' } as any, key))
        .rejects.toThrow('Invalid payload');
    });

    it('should fail decrypt with invalid IV size', async () => {
      const key = await wrapper.generateKey();
      const payload = {
        ciphertext: 'aabbccdd',
        iv: 'aabbcc', // Trop court
        tag: 'aabbccddaabbccdd',
      };

      await expect(wrapper.decrypt(payload, key))
        .rejects.toThrow('Invalid IV size');
    });

    it('should fail decrypt with invalid tag size', async () => {
      const key = await wrapper.generateKey();
      const iv = randomBytes(AES_IV_SIZE);
      const payload = {
        ciphertext: 'aabbccdd',
        iv: wrapper.bytesToHex(iv),
        tag: 'aabb', // Trop court
      };

      await expect(wrapper.decrypt(payload, key))
        .rejects.toThrow('authentication tag mismatch');
    });

    it('should fail asymmetric decrypt with too short ciphertext', async () => {
      const privateKey = secp256k1.utils.randomPrivateKey();
      const payload = {
        ciphertext: 'aabb', // Trop court
        iv: wrapper.bytesToHex(randomBytes(AES_IV_SIZE)),
        tag: wrapper.bytesToHex(randomBytes(AES_TAG_SIZE)),
      };

      await expect(wrapper.decryptAsymmetric(payload, privateKey))
        .rejects.toThrow('too short');
    });
  });
});

// Import nécessaire pour les tests ECIES
import { secp256k1 } from '@noble/curves/secp256k1';
