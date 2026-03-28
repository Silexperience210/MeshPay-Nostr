// @ts-ignore - subpath exports use .js extension
import { sha256 } from '@noble/hashes/sha2.js';
// @ts-ignore - subpath exports use .js extension
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1';

export interface CashuMintInfo {
  name: string;
  pubkey: string;
  version: string;
  description?: string;
  description_long?: string;
  contact?: Array<{ method: string; info: string }>;
  nuts: Record<string, unknown>;
}

export interface CashuKeyset {
  id: string;
  unit: string;
  active: boolean;
  keys: Record<string, string>;
}

export interface CashuKeysetInfo {
  id: string;
  unit: string;
  active: boolean;
}

export interface CashuMintQuote {
  quote: string;
  request: string;
  paid: boolean;
  state?: 'UNPAID' | 'PENDING' | 'PAID'; // NUT-04 v2 (nutshell 0.15+)
  expiry: number;
  amount: number;
}

export function isMintQuotePaid(quote: CashuMintQuote): boolean {
  return quote.paid === true || quote.state === 'PAID';
}

const mintInfoCache: Map<string, { info: CashuMintInfo; timestamp: number }> = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// ─── Mint whitelist ───────────────────────────────────────────────────────────
//
// Mints connus et opérationnels — pré-approuvés hors ligne.
// L'utilisateur peut ajouter ses propres mints via setTrustedMints().
//
const BUILTIN_TRUSTED_MINTS = new Set<string>([
  'https://mint.minibits.cash',
  'https://mint.lnvoltz.com',
  'https://legend.lnbits.com/cashu/api/v1',
  'https://8333.space:3338',
]);

// Mints dynamiques ajoutés par l'utilisateur (depuis AppSettingsProvider)
let _userTrustedMints = new Set<string>();

/**
 * Configure les mints de confiance depuis les settings utilisateur.
 * À appeler depuis AppSettingsProvider à chaque changement de settings.
 */
export function setTrustedMints(urls: string[]): void {
  _userTrustedMints = new Set(urls.map(u => u.replace(/\/$/, '')));
}

/**
 * Vérifie que l'URL du mint est de confiance.
 * @throws si le mint n'est ni builtin ni ajouté par l'utilisateur.
 */
function assertTrustedMint(mintUrl: string): void {
  const origin = (() => {
    try { return new URL(mintUrl).origin; } catch { return mintUrl.replace(/\/$/, ''); }
  })();
  const trusted =
    BUILTIN_TRUSTED_MINTS.has(origin) ||
    _userTrustedMints.has(origin) ||
    _userTrustedMints.has(mintUrl.replace(/\/$/, ''));

  if (!trusted) {
    throw new Error(
      `[Cashu] Mint non autorisé: ${origin}\n` +
      `Ajoutez ce mint dans Paramètres → Cashu Mint pour l'utiliser.`,
    );
  }
}

export interface CashuMeltQuote {
  quote: string;
  amount: number;
  fee_reserve: number;
  paid: boolean;
  expiry: number;
}

export interface CashuProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq?: {
    e: string;
    s: string;
    r?: string;
  };
}

function hashToCurve(message: Uint8Array): InstanceType<typeof secp256k1.ProjectivePoint> {
  const domainSeparator = new TextEncoder().encode('Secp256k1_HashToCurve_Cashu_');
  let counter = 0;

  while (counter < 65536) {
    const counterBytes = new Uint8Array(4);
    new DataView(counterBytes.buffer).setUint32(0, counter, true);

    const combined = new Uint8Array(domainSeparator.length + message.length + counterBytes.length);
    combined.set(domainSeparator, 0);
    combined.set(message, domainSeparator.length);
    combined.set(counterBytes, domainSeparator.length + message.length);

    const hash = sha256(combined);
    const xHex = bytesToHex(hash);

    try {
      const point = secp256k1.ProjectivePoint.fromHex('02' + xHex);
      point.assertValidity();
      return point;
    } catch {
      counter++;
    }
  }

  throw new Error('hashToCurve: failed to find valid point');
}

function generateBlindingFactor(): bigint {
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    throw new Error('crypto.getRandomValues indisponible — environnement non sécurisé');
  }
  const n = secp256k1.CURVE.n;
  const randomBytes = new Uint8Array(32);
  // Rejection sampling — évite le biais modulo (2^256 n'est pas divisible par n)
  let r: bigint;
  do {
    crypto.getRandomValues(randomBytes);
    r = BigInt('0x' + bytesToHex(randomBytes));
  } while (r === 0n || r >= n);
  return r;
}

export interface BlindedMessage {
  amount: number;
  B_: string;
  id: string;
  secret: string;
  r: bigint;
}

function generateSecret(): string {
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    throw new Error('crypto.getRandomValues indisponible — environnement non sécurisé');
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function createBlindedMessage(amount: number, keysetId: string): BlindedMessage {
  const secret = generateSecret();
  const secretBytes = new TextEncoder().encode(secret);

  const Y = hashToCurve(secretBytes);
  const r = generateBlindingFactor();
  const rG = secp256k1.ProjectivePoint.BASE.multiply(r);
  const B_ = Y.add(rG);

  return {
    amount,
    B_: B_.toHex(true),
    id: keysetId,
    secret,
    r,
  };
}

export function createBlindedMessages(
  amounts: number[],
  keysetId: string
): BlindedMessage[] {
  return amounts.map(amount => createBlindedMessage(amount, keysetId));
}

export function unblindSignature(
  C_hex: string,
  r: bigint,
  mintKeyHex: string
): string {
  const C_ = secp256k1.ProjectivePoint.fromHex(C_hex);
  const K = secp256k1.ProjectivePoint.fromHex(mintKeyHex);
  const rK = K.multiply(r);
  const C = C_.add(rK.negate());
  return C.toHex(true);
}

export function splitAmountIntoPowerOfTwo(amount: number): number[] {
  const amounts: number[] = [];
  let remaining = amount;
  let power = 1;

  while (remaining > 0) {
    if (remaining & 1) {
      amounts.push(power);
    }
    remaining >>= 1;
    power <<= 1;
  }

  return amounts.sort((a, b) => a - b);
}

export function verifyDleqProof(
  proof: CashuProof,
  mintPubkeyHex: string
): boolean {
  if (!proof.dleq || !proof.dleq.e || !proof.dleq.s) {
    return true;
  }

  try {
    const e = BigInt('0x' + proof.dleq.e);
    const s = BigInt('0x' + proof.dleq.s);

    const C = secp256k1.ProjectivePoint.fromHex(proof.C);
    const K = secp256k1.ProjectivePoint.fromHex(mintPubkeyHex);

    const sG = secp256k1.ProjectivePoint.BASE.multiply(s);
    const eK = K.multiply(e);
    const R1 = sG.add(eK.negate()); // R1 = s*G - e*K (NUT-12)

    const secretBytes = new TextEncoder().encode(proof.secret);
    const Y = hashToCurve(secretBytes);
    const sY = Y.multiply(s);
    const eC = C.multiply(e);
    const R2 = sY.add(eC.negate()); // R2 = s*Y - e*C (NUT-12)

    // NUT-12: hash sur les bytes bruts 33-byte des points compressés (pas les hex strings)
    const toHash = new Uint8Array([
      ...R1.toRawBytes(true),
      ...R2.toRawBytes(true),
      ...K.toRawBytes(true),
      ...C.toRawBytes(true),
    ]);
    const eComputed = sha256(toHash);
    const eComputedHex = bytesToHex(eComputed);

    const eHex = proof.dleq.e.padStart(64, '0');
    if (eComputedHex === eHex) {
      console.log('[Cashu] DLEQ proof verified for proof:', proof.id);
      return true;
    }

    console.warn('[Cashu] DLEQ verification FAILED for proof:', proof.id);
    return false;
  } catch (err) {
    console.warn('[Cashu] DLEQ verification error:', err);
    return false;
  }
}

export function verifyTokenProofs(token: CashuToken, mintPubkey: string): boolean {
  for (const entry of token.token) {
    for (const proof of entry.proofs) {
      if (!verifyDleqProof(proof, mintPubkey)) {
        console.log('[Cashu] DLEQ verification failed pour proof:', proof.id);
        return false;
      }
    }
  }
  return true;
}

export interface CashuToken {
  token: Array<{
    mint: string;
    proofs: CashuProof[];
  }>;
  memo?: string;
}

export interface StoredCashuToken {
  id: string;
  amount: number;
  mint: string;
  timestamp: number;
  spent: boolean;
  proofs: CashuProof[];
  keysetId: string;
}

export interface CashuWalletBalance {
  totalSats: number;
  byMint: Array<{
    mintUrl: string;
    balance: number;
  }>;
}

export async function fetchMintInfo(mintUrl: string, fallbackUrl?: string): Promise<CashuMintInfo> {
  const cached = mintInfoCache.get(mintUrl);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('[Cashu] Using cached mint info:', mintUrl);
    return cached.info;
  }

  const url = `${mintUrl}/v1/info`;
  console.log('[Cashu] Fetching mint info:', url);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Cashu mint error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log('[Cashu] Mint info:', data.name);

    mintInfoCache.set(mintUrl, { info: data as CashuMintInfo, timestamp: Date.now() });

    return data as CashuMintInfo;
  } catch (err) {
    if (fallbackUrl) {
      console.log('[Cashu] Primary mint failed, trying fallback:', fallbackUrl);
      return fetchMintInfo(fallbackUrl);
    }
    throw err;
  }
}

export async function fetchMintKeysets(mintUrl: string): Promise<{ keysets: CashuKeysetInfo[] }> {
  const url = `${mintUrl}/v1/keysets`;
  console.log('[Cashu] Fetching keysets:', url);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Cashu keyset error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  console.log('[Cashu] Keysets received:', (data as { keysets: CashuKeysetInfo[] }).keysets?.length);
  return data as { keysets: CashuKeysetInfo[] };
}

export async function fetchMintKeys(mintUrl: string, keysetId?: string): Promise<CashuKeyset[]> {
  const url = keysetId
    ? `${mintUrl}/v1/keys/${keysetId}`
    : `${mintUrl}/v1/keys`;
  console.log('[Cashu] Fetching keys:', url);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Cashu keys error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const keysets: CashuKeyset[] = (data as { keysets: CashuKeyset[] }).keysets ?? [];

  // Si un keyset spécifique était demandé, vérifier que le mint l'a bien retourné
  if (keysetId) {
    const match = keysets.find(k => k.id === keysetId);
    if (!match) {
      throw new Error(`Le mint n'a pas retourné le keyset demandé (${keysetId})`);
    }
    return [match];
  }

  return keysets;
}

export async function requestMintQuote(
  mintUrl: string,
  amount: number,
  unit: string = 'sat'
): Promise<CashuMintQuote> {
  assertTrustedMint(mintUrl); // 🔒 Whitelist check
  const url = `${mintUrl}/v1/mint/quote/bolt11`;
  console.log('[Cashu] Requesting mint quote for', amount, unit);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, unit }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Mint quote error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  console.log('[Cashu] Mint quote received:', (data as CashuMintQuote).quote);
  return data as CashuMintQuote;
}

export async function checkMintQuoteStatus(
  mintUrl: string,
  quoteId: string
): Promise<CashuMintQuote> {
  const url = `${mintUrl}/v1/mint/quote/bolt11/${quoteId}`;
  console.log('[Cashu] Checking mint quote status:', quoteId);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Quote status error: ${response.status}`);
  }

  const data = await response.json();
  console.log('[Cashu] Quote status - paid:', (data as CashuMintQuote).paid);
  return data as CashuMintQuote;
}

export async function mintTokens(
  mintUrl: string,
  quoteId: string,
  amount: number,
  keysetId: string,
  mintKeys: Record<string, string>
): Promise<CashuProof[]> {
  assertTrustedMint(mintUrl); // 🔒 Whitelist check
  console.log('[Cashu] Minting tokens for quote:', quoteId, 'amount:', amount);

  const denominations = splitAmountIntoPowerOfTwo(amount);
  const blindedMessages = createBlindedMessages(denominations, keysetId);

  const outputs = blindedMessages.map(bm => ({
    amount: bm.amount,
    B_: bm.B_,
    id: bm.id,
  }));

  const url = `${mintUrl}/v1/mint/bolt11`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quote: quoteId, outputs }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Mint error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  const signatures = (data as { signatures: Array<{ amount: number; C_: string; id: string }> }).signatures;

  console.log('[Cashu] Received', signatures.length, 'signatures from mint');

  if (signatures.length !== blindedMessages.length) {
    throw new Error(`Mint a renvoyé ${signatures.length} signatures pour ${blindedMessages.length} outputs`);
  }

  const proofs: CashuProof[] = signatures.map((sig, i) => {
    const bm = blindedMessages[i];
    const mintKeyForAmount = mintKeys[String(sig.amount)];

    if (!mintKeyForAmount) {
      throw new Error(`Aucune clé mint pour le montant ${sig.amount} sats — keyset incomplet ou mauvais ID`);
    }
    const C = unblindSignature(sig.C_, bm.r, mintKeyForAmount);

    return {
      id: sig.id,
      amount: sig.amount,
      secret: bm.secret,
      C,
    };
  });

  console.log('[Cashu] Minted', proofs.length, 'proofs, total:', proofs.reduce((s, p) => s + p.amount, 0), 'sats');
  return proofs;
}

export async function requestMeltQuote(
  mintUrl: string,
  request: string,
  unit: string = 'sat'
): Promise<CashuMeltQuote> {
  const url = `${mintUrl}/v1/melt/quote/bolt11`;
  console.log('[Cashu] Requesting melt quote');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request, unit }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Melt quote error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  console.log('[Cashu] Melt quote - amount:', (data as CashuMeltQuote).amount, 'fee:', (data as CashuMeltQuote).fee_reserve);
  return data as CashuMeltQuote;
}

export async function checkProofsSpent(
  mintUrl: string,
  proofs: CashuProof[]
): Promise<{ spendable: boolean[] }> {
  const url = `${mintUrl}/v1/checkstate`;
  console.log('[Cashu] Checking', proofs.length, 'proofs state');

  const Ys = proofs.map(p => {
    try {
      const secretBytes = new TextEncoder().encode(p.secret);
      const Y = hashToCurve(secretBytes);
      return Y.toHex(true);
    } catch {
      return p.secret;
    }
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Ys }),
  });

  if (!response.ok) {
    throw new Error(`Check state error: ${response.status}`);
  }

  const data = await response.json();
  const states = (data as { states: Array<{ state: string; Y: string }> }).states;

  if (states) {
    const spendable = states.map(s => s.state === 'UNSPENT');
    return { spendable };
  }

  return data as { spendable: boolean[] };
}

export function encodeCashuToken(token: CashuToken): string {
  const json = JSON.stringify(token);
  // Buffer.from est UTF-8 safe contrairement à btoa()
  const base64 = Buffer.from(json, 'utf8').toString('base64');
  return `cashuA${base64}`;
}

export function decodeCashuToken(encoded: string): CashuToken | null {
  try {
    if (encoded.startsWith('cashuB')) {
      console.log('[Cashu] Format cashuB (V3/CBOR) non supporté');
      return null;
    }
    if (!encoded.startsWith('cashuA')) {
      console.log('[Cashu] Préfixe de token invalide');
      return null;
    }
    const base64 = encoded.slice(6);
    // Buffer.from est UTF-8 safe contrairement à atob()
    const json = Buffer.from(base64, 'base64').toString('utf8');
    const token = JSON.parse(json) as CashuToken;

    // Sanitizer le mémo : limiter la taille et s'assurer que c'est bien une string
    if (token.memo !== undefined) {
      if (typeof token.memo !== 'string') {
        token.memo = undefined;
      } else if (token.memo.length > 1000) {
        token.memo = token.memo.slice(0, 1000);
      }
    }

    console.log('[Cashu] Token décodé avec', token.token?.length, 'entrée(s)');
    return token;
  } catch (err) {
    console.log('[Cashu] Erreur décodage token:', err);
    return null;
  }
}

export function getTokenAmount(token: CashuToken): number {
  let total = 0;
  for (const entry of token.token) {
    for (const proof of entry.proofs) {
      total += proof.amount;
    }
  }
  return total;
}

export async function verifyCashuToken(
  encoded: string,
  trustedMints?: string[]
): Promise<{
  valid: boolean;
  token?: CashuToken;
  amount?: number;
  mintUrl?: string;
  error?: string;
  unverified?: boolean;
}> {
  const token = decodeCashuToken(encoded);
  if (!token) {
    return { valid: false, error: 'Format de token invalide' };
  }

  if (!token.token || token.token.length === 0) {
    return { valid: false, error: 'Token vide' };
  }

  const entry = token.token[0];
  const mintUrl = entry.mint;
  const proofs = entry.proofs;

  if (!proofs || proofs.length === 0) {
    return { valid: false, error: 'Aucun proof dans le token' };
  }

  if (trustedMints && trustedMints.length > 0) {
    const isTrusted = trustedMints.some(m =>
      mintUrl.toLowerCase().includes(m.toLowerCase()) ||
      m.toLowerCase().includes(mintUrl.toLowerCase())
    );
    if (!isTrusted) {
      return { valid: false, error: `Mint non de confiance: ${mintUrl}` };
    }
  }

  try {
    const result = await checkProofsSpent(mintUrl, proofs);
    const anySpent = result.spendable.some(s => !s);
    if (anySpent) {
      return { valid: false, error: 'Token déjà dépensé' };
    }
  } catch (err) {
    console.log('[Cashu] Mint inaccessible, token accepté mais non vérifié:', err);
    const amount = getTokenAmount(token);
    return { valid: true, token, amount, mintUrl, unverified: true };
  }

  const amount = getTokenAmount(token);
  return { valid: true, token, amount, mintUrl, unverified: false };
}

export function generateTokenId(token: CashuToken): string {
  const secrets = token.token.flatMap(t => t.proofs.map(p => p.secret)).sort().join('|');
  const hash = sha256(new TextEncoder().encode(secrets));
  return `cashu_${bytesToHex(hash).slice(0, 12)}_${Date.now().toString(36)}`;
}

export async function testMintConnection(mintUrl: string): Promise<{
  ok: boolean;
  name?: string;
  error?: string;
}> {
  try {
    console.log('[Cashu] Testing mint connection:', mintUrl);
    const info = await fetchMintInfo(mintUrl);
    console.log('[Cashu] Mint connection OK:', info.name);
    return { ok: true, name: info.name };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.log('[Cashu] Mint connection FAILED:', message);
    return { ok: false, error: message };
  }
}

export function formatMintUrl(url: string): string {
  let clean = url.trim().replace(/\/$/, '');
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    clean = 'https://' + clean;
  }
  // Forcer HTTPS sauf pour localhost (tests/dev local)
  const isLocal = clean.includes('localhost') || clean.includes('127.0.0.1') || clean.includes('::1');
  if (!isLocal && clean.startsWith('http://')) {
    console.warn('[Cashu] URL mint non chiffrée (HTTP) — upgrade forcé vers HTTPS');
    clean = 'https://' + clean.slice(7);
  }
  return clean;
}

export interface SwapRequest {
  inputs: CashuProof[];
  outputs: Array<{
    amount: number;
    B_: string;
    id: string;
  }>;
}

export interface SwapResponse {
  signatures: Array<{
    amount: number;
    C_: string;
    id: string;
  }>;
}

export async function swapTokens(
  mintUrl: string,
  inputs: CashuProof[],
  targetAmounts: number[],
  keysetId: string,
  mintKeys: Record<string, string>
): Promise<CashuProof[]> {
  console.log('[Cashu] Swapping', inputs.length, 'proofs for', targetAmounts.length, 'outputs');

  const inputTotal = inputs.reduce((s, p) => s + p.amount, 0);
  const outputTotal = targetAmounts.reduce((s, a) => s + a, 0);
  if (inputTotal !== outputTotal) {
    throw new Error(`Swap invalide: inputs=${inputTotal} sats ≠ outputs=${outputTotal} sats`);
  }

  const blindedMessages = createBlindedMessages(targetAmounts, keysetId);

  const outputs = blindedMessages.map(bm => ({
    amount: bm.amount,
    B_: bm.B_,
    id: bm.id,
  }));

  const url = `${mintUrl}/v1/swap`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs, outputs }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Swap error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  const signatures = (data as SwapResponse).signatures;

  console.log('[Cashu] Swap: received', signatures.length, 'signatures');

  if (signatures.length !== blindedMessages.length) {
    throw new Error(`Swap: mint a renvoyé ${signatures.length} signatures pour ${blindedMessages.length} outputs`);
  }

  const proofs: CashuProof[] = signatures.map((sig, i) => {
    const bm = blindedMessages[i];
    const mintKeyForAmount = mintKeys[String(sig.amount)];

    if (!mintKeyForAmount) {
      throw new Error(`Swap: aucune clé mint pour le montant ${sig.amount} sats — keyset incomplet`);
    }
    const C = unblindSignature(sig.C_, bm.r, mintKeyForAmount);

    return {
      id: sig.id || keysetId,
      amount: sig.amount,
      secret: bm.secret,
      C,
    };
  });

  console.log('[Cashu] Swap successful, new proofs:', proofs.length);
  return proofs;
}


// NUT-07: reclaim sent proofs via swap (invalidates original token for receiver)
export async function reclaimProofs(
  mintUrl: string,
  proofs: CashuProof[],
  keysetId: string,
  mintKeys: Record<string, string>
): Promise<CashuProof[]> {
  const totalAmount = proofs.reduce((s, p) => s + p.amount, 0);
  console.log('[Cashu] Reclaiming', proofs.length, 'proofs,', totalAmount, 'sats');

  const { spendable } = await checkProofsSpent(mintUrl, proofs);
  const unspentProofs = proofs.filter((_, i) => spendable[i] === true);

  if (unspentProofs.length === 0) {
    throw new Error('Tous les proofs ont déjà été dépensés — token épuisé');
  }

  if (unspentProofs.length < proofs.length) {
    const spentCount = proofs.length - unspentProofs.length;
    console.warn(`[Cashu] Reclaim partiel: ${spentCount}/${proofs.length} proofs déjà dépensés, reclaim de ${unspentProofs.length}`);
  }

  const unspentTotal = unspentProofs.reduce((s, p) => s + p.amount, 0);
  const targetAmounts = splitAmountIntoPowerOfTwo(unspentTotal);
  const newProofs = await swapTokens(mintUrl, unspentProofs, targetAmounts, keysetId, mintKeys);
  console.log('[Cashu] Reclaim successful:', newProofs.length, 'new proofs,', unspentTotal, 'sats');
  return newProofs;
}

export async function meltTokens(
  mintUrl: string,
  proofs: CashuProof[],
  invoice: string,
  changeKeysetId?: string,
  changeMintKeys?: Record<string, string>
): Promise<{ paid: boolean; preimage?: string; change?: CashuProof[] }> {
  assertTrustedMint(mintUrl); // 🔒 Whitelist check
  console.log('[Cashu] Melting', proofs.length, 'proofs for invoice');

  const meltQuote = await requestMeltQuote(mintUrl, invoice);
  console.log('[Cashu] Got melt quote:', meltQuote.quote, 'amount:', meltQuote.amount, 'fee:', meltQuote.fee_reserve);

  const totalProofsValue = proofs.reduce((s, p) => s + p.amount, 0);
  const required = meltQuote.amount + meltQuote.fee_reserve;
  if (totalProofsValue < required) {
    throw new Error(
      `Solde insuffisant: ${totalProofsValue} sats disponibles, ${required} requis (${meltQuote.amount} + ${meltQuote.fee_reserve} frais réserve)`
    );
  }

  // NUT-05 v2 : préparer des outputs blindés pour le change potentiel
  // Le mint signe uniquement les outputs correspondant au change réel (fee_reserve - frais_réels)
  let changeBlindedMessages: BlindedMessage[] = [];
  const requestBody: Record<string, unknown> = {
    quote: meltQuote.quote,
    inputs: proofs,
  };

  if (changeKeysetId && changeMintKeys && meltQuote.fee_reserve > 0) {
    const changeAmounts = splitAmountIntoPowerOfTwo(meltQuote.fee_reserve);
    changeBlindedMessages = createBlindedMessages(changeAmounts, changeKeysetId);
    requestBody.outputs = changeBlindedMessages.map(bm => ({
      amount: bm.amount,
      B_: bm.B_,
      id: bm.id,
    }));
    console.log('[Cashu] Sending', changeBlindedMessages.length, 'change outputs (NUT-05 v2)');
  }

  const url = `${mintUrl}/v1/melt/bolt11`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Melt error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  console.log('[Cashu] Melt result - paid:', data.paid);

  // Désaveugler les signatures de change (NUT-05 v2)
  let changeProofs: CashuProof[] | undefined;
  if (data.change && (data.change as unknown[]).length > 0) {
    const rawChange = data.change as Array<{ amount: number; C_: string; id: string }>;
    if (changeBlindedMessages.length > 0 && changeMintKeys) {
      // Désaveugler chaque signature retournée (binary decomposition = montants uniques)
      changeProofs = rawChange.map(sig => {
        const bm = changeBlindedMessages.find(m => m.amount === sig.amount);
        if (!bm) throw new Error(`Change: aucun output blindé pour le montant ${sig.amount} sats`);
        const mintKey = changeMintKeys[String(sig.amount)];
        if (!mintKey) throw new Error(`Change: aucune clé mint pour ${sig.amount} sats`);
        return {
          id: sig.id,
          amount: sig.amount,
          secret: bm.secret,
          C: unblindSignature(sig.C_, bm.r, mintKey),
        };
      });
      const changeTotal = changeProofs.reduce((s, p) => s + p.amount, 0);
      console.log('[Cashu] Change désaveuglé:', changeTotal, 'sats récupérés (frais réels =', meltQuote.fee_reserve - changeTotal, 'sats)');
    } else {
      // Fallback : mint ancien qui retourne des proofs déjà émis
      changeProofs = rawChange as unknown as CashuProof[];
      console.log('[Cashu] Change reçu (format ancien mint):', changeProofs.length, 'proofs');
    }
  }

  return {
    paid: data.paid,
    preimage: data.preimage,
    change: changeProofs,
  };
}

export function splitTokenForQrAnimation(
  token: CashuToken,
  chunkSize: number = 200
): string[] {
  const encoded = encodeCashuToken(token);
  const chunks: string[] = [];

  for (let i = 0; i < encoded.length; i += chunkSize) {
    const chunk = encoded.slice(i, i + chunkSize);
    const partNumber = Math.floor(i / chunkSize) + 1;
    const totalParts = Math.ceil(encoded.length / chunkSize);
    chunks.push(`CASHU${partNumber}/${totalParts}:${chunk}`);
  }

  console.log('[Cashu] Token split into', chunks.length, 'QR chunks');
  return chunks;
}

export function rebuildTokenFromQrChunks(chunks: string[]): CashuToken | null {
  try {
    const sortedChunks = chunks
      .map(c => {
        const match = c.match(/^CASHU(\d+)\/(\d+):(.*)$/);
        if (!match) return null;
        return { part: parseInt(match[1]), total: parseInt(match[2]), data: match[3] };
      })
      .filter(Boolean)
      .sort((a, b) => a!.part - b!.part);

    if (sortedChunks.length === 0) return null;

    const total = sortedChunks[0]!.total;
    if (sortedChunks.length !== total) {
      console.log('[Cashu] Missing QR chunks:', sortedChunks.length, '/', total);
      return null;
    }

    const encoded = sortedChunks.map(c => c!.data).join('');
    return decodeCashuToken(encoded);
  } catch (err) {
    console.log('[Cashu] Error rebuilding token from chunks:', err);
    return null;
  }
}

export interface AtomicSwapRequest {
  id: string;
  from: 'btc' | 'cashu';
  to: 'btc' | 'cashu';
  amount: number;
  hashlock: string;
  timelock: number;
}

export function createAtomicSwap(
  direction: 'btc_to_cashu' | 'cashu_to_btc',
  amount: number,
  secret: string,
  timelockHours: number = 24
): AtomicSwapRequest {
  const idBytes = new Uint8Array(6);
  crypto.getRandomValues(idBytes);
  const id = `swap_${Date.now()}_${bytesToHex(idBytes)}`;
  const secretBytes = new TextEncoder().encode(secret);
  const hashBytes = sha256(secretBytes);
  const hashlock = bytesToHex(hashBytes);
  const timelock = Date.now() + (timelockHours * 60 * 60 * 1000);

  const swap: AtomicSwapRequest = {
    id,
    from: direction === 'btc_to_cashu' ? 'btc' : 'cashu',
    to: direction === 'btc_to_cashu' ? 'cashu' : 'btc',
    amount,
    hashlock,
    timelock,
  };

  console.log('[Cashu] Atomic swap created:', id, direction, amount, 'sats');
  return swap;
}

export function isAtomicSwapValid(swap: AtomicSwapRequest): boolean {
  return Date.now() < swap.timelock;
}

export function claimAtomicSwap(
  swap: AtomicSwapRequest,
  secret: string
): boolean {
  if (!isAtomicSwapValid(swap)) {
    console.log('[Cashu] Swap expired');
    return false;
  }

  const secretBytes = new TextEncoder().encode(secret);
  const hashBytes = sha256(secretBytes);
  const providedHash = bytesToHex(hashBytes);

  if (providedHash !== swap.hashlock) {
    console.log('[Cashu] Invalid secret');
    return false;
  }

  console.log('[Cashu] Atomic swap claimed:', swap.id);
  return true;
}

export function createP2pkToken(
  _token: CashuToken,
  _recipientPubkey: string
): CashuToken {
  // NUT-10 P2PK : le verrouillage doit être appliqué au moment de la création des
  // BlindedMessages (outputs), AVANT l'émission par le mint. Modifier le champ `secret`
  // d'un proof déjà émis rend le proof invalide car le mint a signé hash_to_curve(secret_original).
  throw new Error(
    'createP2pkToken non supporté : le verrouillage P2PK (NUT-10) doit être effectué ' +
    "lors de la création des outputs blindés, pas après l'émission du mint."
  );
}

export function isP2pkToken(token: CashuToken): boolean {
  try {
    const firstProof = token.token[0]?.proofs[0];
    if (!firstProof) return false;

    const secret = JSON.parse(firstProof.secret);
    return Array.isArray(secret) && secret[0] === 'P2PK';
  } catch {
    return false;
  }
}

export function getP2pkPubkey(token: CashuToken): string | null {
  try {
    const firstProof = token.token[0]?.proofs[0];
    if (!firstProof) return null;

    const secret = JSON.parse(firstProof.secret);
    if (Array.isArray(secret) && secret[0] === 'P2PK') {
      return secret[1]?.data || null;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── LNURL-pay — résolution Lightning Address → BOLT11 invoice ───────────────
//
// Protocole LNURL-pay (LUD-06) : user@domain → BOLT11 en 2 requêtes HTTP
// Compatible : Minibits, Phoenix, Wallet of Satoshi, Zeus, LNbits...

export async function fetchLNURLInvoice(
  lnAddress: string,
  amountSats: number,
): Promise<string> {
  const atIdx = lnAddress.lastIndexOf('@');
  if (atIdx < 1) throw new Error('Adresse Lightning invalide (format attendu : user@domain)');
  const user = lnAddress.slice(0, atIdx);
  const domain = lnAddress.slice(atIdx + 1);

  // Étape 1 : métadonnées LNURL-pay
  const metaUrl = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) throw new Error(`Impossible de résoudre ${lnAddress} (HTTP ${metaRes.status})`);
  const meta = await metaRes.json();
  if (meta.status === 'ERROR') throw new Error(meta.reason ?? 'Erreur LNURL-pay');

  const amountMsats = amountSats * 1000;
  if (meta.minSendable && amountMsats < meta.minSendable) {
    throw new Error(`Montant trop faible (minimum ${Math.ceil(meta.minSendable / 1000)} sat)`);
  }
  if (meta.maxSendable && amountMsats > meta.maxSendable) {
    throw new Error(`Montant trop élevé (maximum ${Math.floor(meta.maxSendable / 1000)} sat)`);
  }

  // Étape 2 : invoice BOLT11 pour ce montant
  const sep = meta.callback.includes('?') ? '&' : '?';
  const invoiceRes = await fetch(`${meta.callback}${sep}amount=${amountMsats}`);
  if (!invoiceRes.ok) throw new Error('Impossible de générer l\'invoice Lightning');
  const { pr, status: s2, reason } = await invoiceRes.json();
  if (s2 === 'ERROR') throw new Error(reason ?? 'Erreur génération invoice');
  if (!pr || typeof pr !== 'string') throw new Error('Invoice BOLT11 invalide reçue du vendeur');

  console.log('[LNURL] Invoice générée pour', lnAddress, amountSats, 'sat');
  return pr;
}
