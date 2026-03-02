/**
 * Mempool.space API - Broadcast de transactions Bitcoin
 * Permet d'envoyer des transactions raw hex directement
 */

const MEMPOOL_API_BASE = 'https://mempool.space/api';
const MEMPOOL_TESTNET_API_BASE = 'https://mempool.space/testnet/api';
const BLOCKSTREAM_API_BASE = 'https://blockstream.info/api';
const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_MAINNET_BASE = 'https://mempool.space';

function normalizeBaseUrl(url?: string): string {
  const raw = (url ?? '').trim().replace(/\/$/, '');
  if (!raw) {
    return DEFAULT_MAINNET_BASE;
  }
  return raw;
}

function buildApiCandidates(url?: string): string[] {
  const base = normalizeBaseUrl(url);
  const candidates = new Set<string>();

  candidates.add(base);
  if (!base.endsWith('/api')) {
    candidates.add(`${base}/api`);
  }
  if (base.endsWith('/api')) {
    candidates.add(base.replace(/\/api$/, ''));
  }

  candidates.add(MEMPOOL_API_BASE);
  candidates.add(BLOCKSTREAM_API_BASE);

  return Array.from(candidates);
}

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithFallback<T>(
  pathBuilder: (base: string) => string,
  options?: RequestInit,
  url?: string
): Promise<T> {
  const candidates = buildApiCandidates(url);
  let lastError: Error | null = null;

  for (const candidate of candidates) {
    try {
      const endpoint = pathBuilder(candidate);
      console.log('[Mempool] Tentative requête:', endpoint);
      const response = await fetchWithTimeout(endpoint, options);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as T;
      return data;
    } catch (error) {
      const message = getFetchErrorMessage(error);
      lastError = new Error(message);
      console.warn('[Mempool] Endpoint indisponible:', candidate, '-', message);
    }
  }

  throw new Error(lastError?.message ?? 'Échec réseau mempool');
}

async function fetchTextWithFallback(
  pathBuilder: (base: string) => string,
  options?: RequestInit,
  url?: string
): Promise<string> {
  const candidates = buildApiCandidates(url);
  let lastError: Error | null = null;

  for (const candidate of candidates) {
    try {
      const endpoint = pathBuilder(candidate);
      console.log('[Mempool] Tentative requête texte:', endpoint);
      const response = await fetchWithTimeout(endpoint, options);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}${errorText ? `: ${errorText}` : ''}`);
      }

      return await response.text();
    } catch (error) {
      const message = getFetchErrorMessage(error);
      lastError = new Error(message);
      console.warn('[Mempool] Endpoint texte indisponible:', candidate, '-', message);
    }
  }

  throw new Error(lastError?.message ?? 'Échec réseau mempool');
}

const DEFAULT_FEE_ESTIMATES: MempoolFeeEstimates = {
  fastestFee: 20,
  halfHourFee: 10,
  hourFee: 5,
  economyFee: 2,
  minimumFee: 1,
};

function parseFeeEstimateNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.ceil(value);
}

const MAX_REASONABLE_FEE = 1000; // sat/vB — au-delà = probablement une erreur API ou MITM

function normalizeFeeEstimates(data: unknown): MempoolFeeEstimates {
  const fees = (typeof data === 'object' && data !== null ? data : {}) as Partial<MempoolFeeEstimates>;

  const fastest = parseFeeEstimateNumber(fees.fastestFee, DEFAULT_FEE_ESTIMATES.fastestFee);
  const halfHour = parseFeeEstimateNumber(fees.halfHourFee, DEFAULT_FEE_ESTIMATES.halfHourFee);
  const hour = parseFeeEstimateNumber(fees.hourFee, DEFAULT_FEE_ESTIMATES.hourFee);
  const economy = parseFeeEstimateNumber(fees.economyFee, DEFAULT_FEE_ESTIMATES.economyFee);
  const minimum = parseFeeEstimateNumber(fees.minimumFee, DEFAULT_FEE_ESTIMATES.minimumFee);

  // Sanity check : si l'API retourne des frais absurdes (MITM ou bug), utiliser les valeurs par défaut
  if (fastest > MAX_REASONABLE_FEE || halfHour > MAX_REASONABLE_FEE || economy > MAX_REASONABLE_FEE) {
    console.warn('[Mempool] Frais anormalement élevés reçus de l\'API, utilisation des valeurs par défaut');
    return DEFAULT_FEE_ESTIMATES;
  }

  return {
    fastestFee: fastest,
    halfHourFee: halfHour,
    hourFee: hour,
    economyFee: economy,
    minimumFee: minimum,
  };
}

function getFetchErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function fetchFeeEstimatesFromUrl(baseUrl: string): Promise<MempoolFeeEstimates> {
  const endpoint = `${baseUrl}/v1/fees/recommended`;
  const response = await fetchWithTimeout(endpoint);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data: unknown = await response.json();
  return normalizeFeeEstimates(data);
}

export interface MempoolTxStatus {
  confirmed: boolean;
  blockHeight?: number;
  blockHash?: string;
  blockTime?: number;
}

export interface MempoolUtxo {
  txid: string;
  vout: number;
  value: number;
  status: MempoolTxStatus;
  address?: string; // adresse propriétaire — attachée localement (non retournée par l'API)
}

export interface MempoolFeeEstimates {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

// Alias pour compatibilité (ancien nom singulier utilisé dans certains composants)
export type MempoolFeeEstimate = MempoolFeeEstimates;

/**
 * Teste la connexion à mempool.space
 */
export async function testMempoolConnection(url?: string): Promise<{ success: boolean; error?: string }> {
  try {
    const height = await fetchTextWithFallback(
      (baseUrl) => `${baseUrl}/blocks/tip/height`,
      {
        method: 'GET',
        headers: { Accept: 'text/plain' },
      },
      url
    );
    console.log('[Mempool] Connecté, hauteur bloc:', height);
    return { success: true };
  } catch (error) {
    console.error('[Mempool] Erreur connexion:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Récupère les UTXOs d'une adresse Bitcoin
 */
export async function getAddressUtxos(address: string, url?: string): Promise<MempoolUtxo[]> {
  try {
    const utxos = await fetchJsonWithFallback<MempoolUtxo[]>(
      (baseUrl) => `${baseUrl}/address/${address}/utxo`,
      undefined,
      url
    );
    // Attacher l'adresse source à chaque UTXO (l'API Mempool ne la retourne pas)
    const withAddress = utxos.map(u => ({ ...u, address }));
    console.log(`[Mempool] ${withAddress.length} UTXOs trouvés pour ${address}`);
    return withAddress;
  } catch (error) {
    console.error('[Mempool] Erreur récupération UTXOs:', error);
    throw error;
  }
}

/**
 * Récupère le solde confirmé d'une adresse
 */
export async function getAddressBalance(address: string, url?: string): Promise<{ confirmed: number; unconfirmed: number; total: number }> {
  try {
    const data = await fetchJsonWithFallback<Record<string, any>>(
      (baseUrl) => `${baseUrl}/address/${address}`,
      undefined,
      url
    );
    const confirmed = data.chain_stats?.funded_txo_sum - data.chain_stats?.spent_txo_sum || 0;
    const unconfirmed = data.mempool_stats?.funded_txo_sum - data.mempool_stats?.spent_txo_sum || 0;
    
    return { confirmed, unconfirmed, total: confirmed + unconfirmed };
  } catch (error) {
    console.error('[Mempool] Erreur récupération solde:', error);
    throw error;
  }
}

/**
 * Récupère les estimations de frais actuels
 */
export async function getFeeEstimates(url?: string): Promise<MempoolFeeEstimates> {
  const primaryUrl = url || MEMPOOL_API_BASE;
  const fallbackUrls = primaryUrl === MEMPOOL_API_BASE
    ? [MEMPOOL_TESTNET_API_BASE]
    : [MEMPOOL_API_BASE, MEMPOOL_TESTNET_API_BASE].filter((item) => item !== primaryUrl);
  const candidates = [primaryUrl, ...fallbackUrls];

  for (const candidate of candidates) {
    try {
      const estimates = await fetchFeeEstimatesFromUrl(candidate);
      console.log('[Mempool] Frais récupérés depuis:', candidate, estimates);
      return estimates;
    } catch (error) {
      console.warn('[Mempool] Échec récupération frais sur', candidate, '-', getFetchErrorMessage(error));
    }
  }

  console.warn('[Mempool] Utilisation des frais par défaut');
  return DEFAULT_FEE_ESTIMATES;
}

/**
 * Broadcast une transaction raw hex sur le réseau Bitcoin
 * C'est la fonction clé pour envoyer des bitcoins
 */
export async function broadcastTransaction(txHex: string, url?: string): Promise<{ txid: string }> {
  try {
    console.log('[Mempool] Broadcast transaction...');
    const txid = await fetchTextWithFallback(
      (baseUrl) => `${baseUrl}/tx`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: txHex,
      },
      url
    );
    // Valider que le txid est bien un hash Bitcoin (64 hex chars = 32 bytes)
    const cleanTxid = txid.trim();
    if (!/^[a-f0-9]{64}$/i.test(cleanTxid)) {
      throw new Error(`Format txid invalide reçu du serveur : ${cleanTxid.slice(0, 60)}`);
    }

    console.log('[Mempool] Transaction broadcastée:', cleanTxid);
    return { txid: cleanTxid };
  } catch (error) {
    console.error('[Mempool] Erreur broadcast:', error);
    throw error;
  }
}

/**
 * Récupère le statut d'une transaction
 */
export async function getTransactionStatus(txid: string): Promise<MempoolTxStatus> {
  try {
    return await fetchJsonWithFallback<MempoolTxStatus>(
      (baseUrl) => `${baseUrl}/tx/${txid}/status`
    );
  } catch (error) {
    console.error('[Mempool] Erreur statut transaction:', error);
    throw error;
  }
}

/**
 * Récupère le prix actuel du Bitcoin en USD
 */
export async function getBitcoinPrice(): Promise<number> {
  try {
    const data = await fetchJsonWithFallback<Record<string, number>>(
      (baseUrl) => `${baseUrl}/v1/prices`
    );
    const price = data.USD;
    console.log('[Mempool] Prix Bitcoin:', price, 'USD');
    return price;
  } catch (error) {
    console.error('[Mempool] Erreur récupération prix:', error);
    // Fallback sur prix approximatif si API fail
    return 65000;
  }
}

/**
 * Récupère l'historique des transactions d'une adresse
 */
export async function getAddressTransactions(address: string, limit: number = 50, url?: string): Promise<any[]> {
  try {
    const txs = await fetchJsonWithFallback<any[]>(
      (baseUrl) => `${baseUrl}/address/${address}/txs`,
      undefined,
      url
    );
    return txs.slice(0, limit);
  } catch (error) {
    console.error('[Mempool] Erreur historique transactions:', error);
    throw error;
  }
}

// Aliases pour compatibilité
export const fetchAddressBalance = getAddressBalance;
export const fetchAddressTransactions = getAddressTransactions;
export const fetchFeeEstimates = getFeeEstimates;
export const fetchBtcPrice = async (_mempoolUrl?: string, currency?: string): Promise<number> => {
  try {
    // Utiliser CoinGecko API (plus fiable que mempool.space)
    const vsCurrency = currency?.toLowerCase() || 'usd';
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${vsCurrency}`;
    console.log('[Price] Fetching from CoinGecko:', url);
    
    const response = await fetchWithTimeout(url);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    console.log('[Price] CoinGecko data:', data);
    
    const price = data.bitcoin[vsCurrency];
    console.log('[Price] Prix BTC:', price, currency || 'USD');
    return price;
  } catch (error) {
    console.warn('[Price] API indisponible, prix indicatif (mars 2026)');
    // Valeurs indicatives — rafraîchir dès que l'API répond
    return currency === 'EUR' ? 82000 : 88000;
  }
};
export const formatTransactions = (raw: any[], addresses: string[]): any[] => raw;
export const satsToBtc = (sats: number): string => (sats / 100000000).toFixed(8);
export const satsToFiat = (sats: number, price: number): number => (sats / 100000000) * price;

export interface AddressBalance {
  confirmed: number;
  unconfirmed: number;
  total: number;
}

export interface FormattedTransaction {
  txid: string;
  amount: number;
  type: 'incoming' | 'outgoing';
  confirmed: boolean;
  timestamp?: number;
  blockTime?: number;
  fee?: number;
}

// MempoolFeeEstimate est désormais un alias de MempoolFeeEstimates (défini plus haut)
