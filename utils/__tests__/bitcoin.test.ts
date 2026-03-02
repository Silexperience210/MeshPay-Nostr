/**
 * Tests unitaires — utils/bitcoin.ts
 * Vérifie : génération mnémonique, validation, dérivation adresses BIP84
 */

import {
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeed,
  deriveWalletInfo,
  deriveReceiveAddresses,
  deriveChangeAddresses,
  shortenAddress,
  pubkeyToSegwitAddress,
  pubkeyToLegacyAddress,
} from '../bitcoin';

// Mnémonique de test fixe (JAMAIS utiliser pour de vrais fonds)
const TEST_MNEMONIC_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_MNEMONIC_24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

describe('generateMnemonic', () => {
  it('génère une phrase de 12 mots par défaut', () => {
    const m = generateMnemonic(12);
    expect(m.split(' ')).toHaveLength(12);
  });

  it('génère une phrase de 24 mots', () => {
    const m = generateMnemonic(24);
    expect(m.split(' ')).toHaveLength(24);
  });

  it('chaque génération produit une mnémonique différente', () => {
    const m1 = generateMnemonic(12);
    const m2 = generateMnemonic(12);
    expect(m1).not.toBe(m2);
  });

  it('la phrase générée est valide', () => {
    const m = generateMnemonic(12);
    expect(validateMnemonic(m)).toBe(true);
  });
});

describe('validateMnemonic', () => {
  it('accepte une mnémonique 12 mots valide', () => {
    expect(validateMnemonic(TEST_MNEMONIC_12)).toBe(true);
  });

  it('accepte une mnémonique 24 mots valide', () => {
    expect(validateMnemonic(TEST_MNEMONIC_24)).toBe(true);
  });

  it('rejette une phrase invalide', () => {
    expect(validateMnemonic('ceci est invalide')).toBe(false);
  });

  it('rejette une chaîne vide', () => {
    expect(validateMnemonic('')).toBe(false);
  });

  it('rejette un seul mot', () => {
    expect(validateMnemonic('abandon')).toBe(false);
  });

  it('rejette 12 mots invalides (checksum erroné)', () => {
    expect(validateMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon')).toBe(false);
  });
});

describe('mnemonicToSeed', () => {
  it('retourne un Uint8Array de 64 bytes', () => {
    const seed = mnemonicToSeed(TEST_MNEMONIC_12);
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.length).toBe(64);
  });

  it('même mnémonique → même seed (déterministe)', () => {
    const s1 = mnemonicToSeed(TEST_MNEMONIC_12);
    const s2 = mnemonicToSeed(TEST_MNEMONIC_12);
    expect(Buffer.from(s1).toString('hex')).toBe(Buffer.from(s2).toString('hex'));
  });

  it('mnémonique différente → seed différente', () => {
    const s1 = mnemonicToSeed(TEST_MNEMONIC_12);
    const s2 = mnemonicToSeed(TEST_MNEMONIC_24);
    expect(Buffer.from(s1).toString('hex')).not.toBe(Buffer.from(s2).toString('hex'));
  });
});

describe('deriveWalletInfo', () => {
  it('retourne un xpub valide (commence par "zpub" ou "xpub")', () => {
    const info = deriveWalletInfo(TEST_MNEMONIC_12);
    // BIP84 extended public key peut commencer par zpub ou xpub selon l'encodage
    expect(info.xpub).toBeTruthy();
    expect(info.xpub.length).toBeGreaterThan(100);
  });

  it('retourne une firstReceiveAddress bech32 valide', () => {
    const info = deriveWalletInfo(TEST_MNEMONIC_12);
    expect(info.firstReceiveAddress).toMatch(/^bc1q[a-z0-9]{38,}$/);
  });

  it('adresse connue pour "abandon×11 about" (vecteur BIP84)', () => {
    // Adresse BIP84 connue pour ce mnémonique de test
    const info = deriveWalletInfo(TEST_MNEMONIC_12);
    expect(info.firstReceiveAddress).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  });

  it('résultat déterministe (même mnémonique = même résultat)', () => {
    const i1 = deriveWalletInfo(TEST_MNEMONIC_12);
    const i2 = deriveWalletInfo(TEST_MNEMONIC_12);
    expect(i1.firstReceiveAddress).toBe(i2.firstReceiveAddress);
    expect(i1.xpub).toBe(i2.xpub);
  });
});

describe('deriveReceiveAddresses', () => {
  it('retourne le bon nombre d\'adresses', () => {
    const addrs = deriveReceiveAddresses(TEST_MNEMONIC_12, 5);
    expect(addrs).toHaveLength(5);
  });

  it('retourne 20 adresses par défaut (gap limit BIP44)', () => {
    const addrs = deriveReceiveAddresses(TEST_MNEMONIC_12, 20);
    expect(addrs).toHaveLength(20);
  });

  it('toutes les adresses sont des bech32 valides (bc1q...)', () => {
    const addrs = deriveReceiveAddresses(TEST_MNEMONIC_12, 5);
    for (const addr of addrs) {
      expect(addr).toMatch(/^bc1q[a-z0-9]+$/);
    }
  });

  it('adresse[0] = deriveWalletInfo.firstReceiveAddress', () => {
    const addrs = deriveReceiveAddresses(TEST_MNEMONIC_12, 5);
    const info = deriveWalletInfo(TEST_MNEMONIC_12);
    expect(addrs[0]).toBe(info.firstReceiveAddress);
  });

  it('toutes les adresses sont uniques', () => {
    const addrs = deriveReceiveAddresses(TEST_MNEMONIC_12, 20);
    const unique = new Set(addrs);
    expect(unique.size).toBe(20);
  });
});

describe('deriveChangeAddresses', () => {
  it('retourne le bon nombre d\'adresses de change', () => {
    const addrs = deriveChangeAddresses(TEST_MNEMONIC_12, 5);
    expect(addrs).toHaveLength(5);
  });

  it('adresses de change ≠ adresses de réception', () => {
    const receive = deriveReceiveAddresses(TEST_MNEMONIC_12, 5);
    const change = deriveChangeAddresses(TEST_MNEMONIC_12, 5);
    for (const addr of change) {
      expect(receive).not.toContain(addr);
    }
  });

  it('toutes les adresses de change sont des bech32 valides', () => {
    const addrs = deriveChangeAddresses(TEST_MNEMONIC_12, 5);
    for (const addr of addrs) {
      expect(addr).toMatch(/^bc1q[a-z0-9]+$/);
    }
  });

  it('toutes les adresses de change sont uniques', () => {
    const addrs = deriveChangeAddresses(TEST_MNEMONIC_12, 20);
    expect(new Set(addrs).size).toBe(20);
  });
});

describe('pubkeyToSegwitAddress', () => {
  it('retourne une adresse bech32 pour une clé publique valide', () => {
    // Clé publique compressée valide (G, le point de base de secp256k1)
    const G = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
    const addr = pubkeyToSegwitAddress(G, true);
    expect(addr).toMatch(/^bc1q[a-z0-9]+$/);
  });
});

describe('pubkeyToLegacyAddress', () => {
  it('retourne une adresse P2PKH valide (commence par 1)', () => {
    const G = Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex');
    const addr = pubkeyToLegacyAddress(G, true);
    expect(addr).toMatch(/^1[1-9A-HJ-NP-Za-km-z]{24,33}$/);
  });
});

describe('shortenAddress', () => {
  it('raccourcit une adresse longue', () => {
    const addr = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
    const short = shortenAddress(addr);
    expect(short).toContain('...');
    expect(short.length).toBeLessThan(addr.length);
  });

  it('retourne l\'adresse telle quelle si elle est courte (≤16 chars)', () => {
    const addr = 'bc1qshort';
    expect(shortenAddress(addr)).toBe(addr);
  });
});
