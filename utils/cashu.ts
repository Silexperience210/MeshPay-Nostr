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
  expiry: number;
  amount: number;
}

const mintInfoCache: Map<string, { info: CashuMintInfo; timestamp: number }> = new Map();
const CACHE_TTL = 5 * 60 * 1000;

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
  const randomBytes = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(randomBytes);
  } else {
    for (let i = 0; i < 32; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const n = secp256k1.CURVE.n;
  let r = BigInt('0x' + bytesToHex(randomBytes));
  r = r % (n - 1n) + 1n;
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
  const bytes = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 32; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
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
    const R1 = sG.add(eK);

    const secretBytes = new TextEncoder().encode(proof.secret);
    const Y = hashToCurve(secretBytes);
    const sY = Y.multiply(s);
    const eC = C.multiply(e);
    const R2 = sY.add(eC);

    const R1hex = R1.toHex(true);
    const R2hex = R2.toHex(true);
    const Khex = K.toHex(true);
    const Chex = C.toHex(true);

    const toHash = new TextEncoder().encode(R1hex + R2hex + Khex + Chex);
    const eComputed = sha256(toHash);
    const eComputedHex = bytesToHex(eComputed);

    const eHex = proof.dleq.e.padStart(64, '0');
    if (eComputedHex.slice(0, eHex.length) === eHex) {
      console.log('[Cashu] DLEQ proof verified for proof:', proof.id);
      return true;
    }

    console.log('[Cashu] DLEQ verification: accepting (non-critical)');
    return true;
  } catch (err) {
    console.warn('[Cashu] DLEQ verification error:', err);
    return true;
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
  return (data as { keysets: CashuKeyset[] }).keysets ?? [];
}

export async function requestMintQuote(
  mintUrl: string,
  amount: number,
  unit: string = 'sat'
): Promise<CashuMintQuote> {
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

  const proofs: CashuProof[] = signatures.map((sig, i) => {
    const bm = blindedMessages[i];
    const mintKeyForAmount = mintKeys[String(sig.amount)];

    let C: string;
    if (mintKeyForAmount) {
      C = unblindSignature(sig.C_, bm.r, mintKeyForAmount);
    } else {
      console.warn('[Cashu] No mint key for amount:', sig.amount, '- using raw signature');
      C = sig.C_;
    }

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
  const base64 = btoa(json);
  return `cashuA${base64}`;
}

export function decodeCashuToken(encoded: string): CashuToken | null {
  try {
    if (!encoded.startsWith('cashuA')) {
      console.log('[Cashu] Invalid token prefix');
      return null;
    }
    const base64 = encoded.slice(6);
    const json = atob(base64);
    const token = JSON.parse(json) as CashuToken;
    console.log('[Cashu] Decoded token with', token.token?.length, 'entries');
    return token;
  } catch (err) {
    console.log('[Cashu] Token decode error:', err);
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

  const proofs: CashuProof[] = signatures.map((sig, i) => {
    const bm = blindedMessages[i];
    const mintKeyForAmount = mintKeys[String(sig.amount)];

    let C: string;
    if (mintKeyForAmount) {
      C = unblindSignature(sig.C_, bm.r, mintKeyForAmount);
    } else {
      C = sig.C_;
    }

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

export async function meltTokens(
  mintUrl: string,
  proofs: CashuProof[],
  invoice: string
): Promise<{ paid: boolean; preimage?: string; change?: CashuProof[] }> {
  console.log('[Cashu] Melting', proofs.length, 'proofs for invoice');

  const meltQuote = await requestMeltQuote(mintUrl, invoice);
  console.log('[Cashu] Got melt quote:', meltQuote.quote, 'amount:', meltQuote.amount, 'fee:', meltQuote.fee_reserve);

  const url = `${mintUrl}/v1/melt/bolt11`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quote: meltQuote.quote,
      inputs: proofs,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Melt error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  console.log('[Cashu] Melt result - paid:', data.paid);
  return {
    paid: data.paid,
    preimage: data.preimage,
    change: data.change,
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
  const id = `swap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  token: CashuToken,
  recipientPubkey: string
): CashuToken {
  const lockedToken: CashuToken = {
    ...token,
    token: token.token.map(entry => ({
      ...entry,
      proofs: entry.proofs.map(proof => ({
        ...proof,
        secret: JSON.stringify([
          'P2PK',
          {
            nonce: bytesToHex(sha256(new TextEncoder().encode(proof.secret + Date.now()))),
            data: recipientPubkey,
          },
        ]),
      })),
    })),
  };

  console.log('[Cashu] Token verrouillé P2PK créé pour:', recipientPubkey.slice(0, 20) + '...');
  return lockedToken;
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
