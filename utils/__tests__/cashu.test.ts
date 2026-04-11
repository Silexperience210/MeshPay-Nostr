/**
 * Tests unitaires — utils/cashu.ts
 * Vérifie : BDHKE, encodage/décodage tokens, calculs fees/amounts
 */

import {
  createBlindedMessage,
  unblindSignature,
  splitAmountIntoPowerOfTwo,
  encodeCashuToken,
  decodeCashuToken,
  getTokenAmount,
  generateTokenId,
  verifyDleqProof,
  type CashuToken,
  type CashuProof,
} from '../cashu';

// ──────────────────────────────────────────────
// splitAmountIntoPowerOfTwo
// ──────────────────────────────────────────────
describe('splitAmountIntoPowerOfTwo', () => {
  it('1 → [1]', () => expect(splitAmountIntoPowerOfTwo(1)).toEqual([1]));
  it('3 → [1, 2]', () => expect(splitAmountIntoPowerOfTwo(3)).toEqual([1, 2]));
  it('4 → [4]', () => expect(splitAmountIntoPowerOfTwo(4)).toEqual([4]));
  it('7 → [1, 2, 4]', () => expect(splitAmountIntoPowerOfTwo(7)).toEqual([1, 2, 4]));
  it('la somme des parties égale l\'original', () => {
    for (const n of [10, 100, 1000, 9999, 65535]) {
      const parts = splitAmountIntoPowerOfTwo(n);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(n);
    }
  });
  it('pas de doublons', () => {
    const parts = splitAmountIntoPowerOfTwo(127);
    expect(new Set(parts).size).toBe(parts.length);
  });
  it('trié croissant', () => {
    const parts = splitAmountIntoPowerOfTwo(63);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]).toBeGreaterThan(parts[i - 1]);
    }
  });
});

// ──────────────────────────────────────────────
// encodeCashuToken / decodeCashuToken
// ──────────────────────────────────────────────
const SAMPLE_TOKEN: CashuToken = {
  token: [
    {
      mint: 'https://legend.lnbits.com',
      proofs: [
        { id: 'abc123', amount: 1000, secret: 'mysecret', C: '02abc' },
        { id: 'abc123', amount: 500, secret: 'mysecret2', C: '02def' },
      ],
    },
  ],
  memo: 'test token',
};

describe('encodeCashuToken / decodeCashuToken', () => {
  it('encode et décode sans perte', () => {
    const encoded = encodeCashuToken(SAMPLE_TOKEN);
    const decoded = decodeCashuToken(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.token[0].mint).toBe(SAMPLE_TOKEN.token[0].mint);
    expect(decoded!.token[0].proofs).toHaveLength(2);
    expect(decoded!.memo).toBe('test token');
  });

  it('token encodé commence par "cashuA"', () => {
    expect(encodeCashuToken(SAMPLE_TOKEN)).toMatch(/^cashuA/);
  });

  it('décode un token sans memo', () => {
    const t: CashuToken = { token: [{ mint: 'https://test.mint', proofs: [] }] };
    const decoded = decodeCashuToken(encodeCashuToken(t));
    expect(decoded).not.toBeNull();
    expect(decoded!.token[0].mint).toBe('https://test.mint');
  });

  it('UTF-8 safe : memo avec accents français', () => {
    const t: CashuToken = {
      token: [{ mint: 'https://test', proofs: [] }],
      memo: 'Paiement café à Paris — éàü',
    };
    const decoded = decodeCashuToken(encodeCashuToken(t));
    expect(decoded!.memo).toBe('Paiement café à Paris — éàü');
  });

  it('retourne null pour un token cashuB (non supporté)', () => {
    expect(decodeCashuToken('cashuBsomedata')).toBeNull();
  });

  it('retourne null pour un préfixe inconnu', () => {
    expect(decodeCashuToken('invalidprefix')).toBeNull();
  });

  it('retourne null pour du base64 corrompu', () => {
    expect(decodeCashuToken('cashuA!!!invalid_base64!!!')).toBeNull();
  });

  it('retourne null pour une chaîne vide', () => {
    expect(decodeCashuToken('')).toBeNull();
  });
});

// ──────────────────────────────────────────────
// getTokenAmount
// ──────────────────────────────────────────────
describe('getTokenAmount', () => {
  it('calcule la somme de tous les proofs', () => {
    expect(getTokenAmount(SAMPLE_TOKEN)).toBe(1500);
  });

  it('retourne 0 pour un token vide', () => {
    const empty: CashuToken = { token: [{ mint: 'x', proofs: [] }] };
    expect(getTokenAmount(empty)).toBe(0);
  });

  it('additionne correctement plusieurs entrées mint', () => {
    const multi: CashuToken = {
      token: [
        { mint: 'mintA', proofs: [{ id: '1', amount: 100, secret: 'a', C: 'Ca' }] },
        { mint: 'mintB', proofs: [{ id: '2', amount: 200, secret: 'b', C: 'Cb' }] },
      ],
    };
    expect(getTokenAmount(multi)).toBe(300);
  });
});

// ──────────────────────────────────────────────
// generateTokenId
// ──────────────────────────────────────────────
describe('generateTokenId', () => {
  it('retourne une chaîne non vide commençant par "cashu_"', () => {
    const id = generateTokenId(SAMPLE_TOKEN);
    expect(id).toMatch(/^cashu_[a-f0-9]{12}_[a-z0-9]+$/);
  });

  it('deux tokens identiques → même ID (déterministe sur les secrets)', () => {
    const id1 = generateTokenId(SAMPLE_TOKEN);
    const id2 = generateTokenId(SAMPLE_TOKEN);
    // Le prefix est déterministe, le suffix varie (timestamp)
    const prefix1 = id1.split('_').slice(0, 2).join('_');
    const prefix2 = id2.split('_').slice(0, 2).join('_');
    expect(prefix1).toBe(prefix2);
  });

  it('deux tokens différents → IDs différents', () => {
    const t2: CashuToken = { token: [{ mint: 'x', proofs: [{ id: '1', amount: 1, secret: 'different', C: 'C' }] }] };
    const id1 = generateTokenId(SAMPLE_TOKEN);
    const id2 = generateTokenId(t2);
    const hash1 = id1.split('_')[1];
    const hash2 = id2.split('_')[1];
    expect(hash1).not.toBe(hash2);
  });
});

// ──────────────────────────────────────────────
// createBlindedMessage / unblindSignature (BDHKE)
// ──────────────────────────────────────────────
describe('createBlindedMessage', () => {
  it('retourne les champs requis', () => {
    const bm = createBlindedMessage(1000, 'keyset123');
    expect(bm.amount).toBe(1000);
    expect(bm.id).toBe('keyset123');
    expect(typeof bm.secret).toBe('string');
    expect(bm.secret.length).toBe(64); // hex 32 bytes
    expect(typeof bm.B_).toBe('string');
    expect(bm.B_.length).toBeGreaterThan(60); // compressed point hex
    expect(typeof bm.r).toBe('bigint');
    expect(bm.r).toBeGreaterThan(0n);
  });

  it('chaque appel produit des résultats différents (aléatoire)', () => {
    const bm1 = createBlindedMessage(1000, 'ks');
    const bm2 = createBlindedMessage(1000, 'ks');
    expect(bm1.secret).not.toBe(bm2.secret);
    expect(bm1.B_).not.toBe(bm2.B_);
    expect(bm1.r).not.toBe(bm2.r);
  });

  it('le point aveuglé B_ est un point de courbe compressé valide', () => {
    const bm = createBlindedMessage(100, 'ks');
    // Points compressés: 02 ou 03 suivi de 32 bytes hex = 66 chars
    expect(bm.B_).toMatch(/^0[23][a-f0-9]{64}$/);
  });
});

describe('BDHKE round-trip (createBlindedMessage + unblindSignature)', () => {
  it('désaveugler une signature produit un point de courbe valide', () => {
    const { secp256k1 } = require('@noble/curves/secp256k1');

    // Clé du mint simulée : k = 1 (scalaire trivial), K = G (point de base)
    const k = 1n;
    const K = secp256k1.ProjectivePoint.BASE;

    // Créer un message aveuglé
    const bm = createBlindedMessage(1000, 'testKeyset');

    // Simuler la signature mint : C_ = k * B_
    const B_ = secp256k1.ProjectivePoint.fromHex(bm.B_);
    const C_point = B_.multiply(k);
    const C_hex = C_point.toHex(true);

    // Désaveugler
    const mintKeyHex = K.toHex(true); // k=1, donc K=G
    const C = unblindSignature(C_hex, bm.r, mintKeyHex);

    // C doit être un point de courbe valide
    expect(C).toMatch(/^0[23][a-f0-9]{64}$/);

    // C = k * Y (où Y = hashToCurve(secret)) — on vérifie juste que c'est un point valide
    const Cpoint = secp256k1.ProjectivePoint.fromHex(C);
    expect(() => Cpoint.assertValidity()).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// verifyDleqProof — structure de base
// ──────────────────────────────────────────────
describe('verifyDleqProof', () => {
  it('retourne true si pas de champ dleq et DLEQ non requis (mode legacy)', () => {
    const proof: CashuProof = { id: '1', amount: 100, secret: 'test', C: '02abc' };
    // En mode legacy (requireDleq=false), pas de dleq = accepté
    expect(verifyDleqProof(proof, '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', false)).toBe(true);
  });

  it('retourne false si pas de champ dleq et DLEQ requis (défaut NUT-12)', () => {
    const proof: CashuProof = { id: '1', amount: 100, secret: 'test', C: '02abc' };
    // Par défaut DLEQ_REQUIRED=true, pas de dleq = rejeté
    expect(verifyDleqProof(proof, '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')).toBe(false);
  });

  it('retourne false (ou true) — ne jamais crash sur des données invalides', () => {
    const proof: CashuProof = {
      id: '1',
      amount: 100,
      secret: 'secret',
      C: '02abc', // C invalide mais ne doit pas crash
      dleq: { e: '0'.repeat(64), s: '0'.repeat(64) },
    };
    // Doit retourner false ou true, jamais throw
    const result = verifyDleqProof(proof, '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
    expect(typeof result).toBe('boolean');
  });

  it('retourne false sur une preuve DLEQ manifestement invalide', () => {
    // e=0, s=0 ne peut jamais être une preuve DLEQ valide
    const proof: CashuProof = {
      id: '1',
      amount: 100,
      secret: 'topsecret',
      C: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      dleq: { e: '0'.repeat(64), s: '0'.repeat(64) },
    };
    const mintPubkey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
    expect(verifyDleqProof(proof, mintPubkey)).toBe(false);
  });
});

// ──────────────────────────────────────────────
// createP2pkToken — doit throw (correctif sécurité)
// ──────────────────────────────────────────────
describe('createP2pkToken', () => {
  it('throw avec message explicatif (NUT-10 pas supporté après émission)', () => {
    const { createP2pkToken } = require('../cashu');
    expect(() => createP2pkToken(SAMPLE_TOKEN, '02abc...')).toThrow(/NUT-10/);
  });
});
