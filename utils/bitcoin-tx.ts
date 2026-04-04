/**
 * Bitcoin transactions - Création et signature de transactions Bitcoin
 * Utilise bitcoinjs-lib pour la construction et secp256k1 pour la signature
 * Compatible React Native (pas de WASM)
 */
import * as bitcoin from 'bitcoinjs-lib';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeed, pubkeyToSegwitAddress } from '@/utils/bitcoin';
// @ts-ignore - subpath exports use .js extension
import { sha256 } from '@noble/hashes/sha2.js';
// @ts-ignore - subpath exports use .js extension
import { ripemd160 } from '@noble/hashes/legacy.js';
import type { MempoolUtxo } from './mempool';
import * as secp256k1 from 'secp256k1';

const NETWORK = bitcoin.networks.bitcoin;
const DUST_LIMIT = 546;
const MAX_ADDRESS_SCAN = 20;

// ─── Constantes de sécurité ─────────────────────────────────────────────────
const MAX_FEE_RATE = 1000; // sats/vbyte - protection contre fee attack
const MAX_TRANSACTION_FEE = 1000000; // 0.01 BTC max fee totale
const MAX_LOCKTIME = 500000000; // Timestamp max (vs block height)
const MAX_SEQUENCE = 0xffffffff;
const SEQUENCE_FINAL = 0xffffffff;
const ENABLE_LOCKTIME_MASK = 0x7fffffff;

export interface TxInput {
  txid: string;
  vout: number;
  value: number;
  scriptPubKey: string;
}

export interface TxOutput {
  address: string;
  value: number;
}

export interface UnsignedTransaction {
  hex: string;
  txid: string;
  fee: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  locktime?: number;
  version?: number;
}

interface DerivedAddress {
  index: number;
  address: string;
  publicKey: Uint8Array;
  scriptPubKey: Buffer;
}

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

function deriveAddresses(mnemonic: string, count: number = MAX_ADDRESS_SCAN): DerivedAddress[] {
  const seed = mnemonicToSeed(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const accountKey = master.derive("m/84'/0'/0'");
  const addresses: DerivedAddress[] = [];

  for (let i = 0; i < count; i++) {
    const child = accountKey.deriveChild(0).deriveChild(i);
    if (child.publicKey) {
      const h160 = hash160(child.publicKey);
      const scriptPubKey = Buffer.alloc(22);
      scriptPubKey[0] = 0x00; // OP_0
      scriptPubKey[1] = 0x14; // PUSH 20 bytes
      Buffer.from(h160).copy(scriptPubKey, 2);

      const address = pubkeyToSegwitAddress(child.publicKey, true);

      addresses.push({
        index: i,
        address,
        publicKey: child.publicKey,
        scriptPubKey,
      });
    }
  }

  return addresses;
}

/**
 * Valide un rate de fee.
 * @throws si le fee rate dépasse la limite maximale
 */
export function validateFeeRate(feeRate: number): void {
  if (typeof feeRate !== 'number' || !Number.isFinite(feeRate)) {
    throw new Error('Fee rate invalide: doit être un nombre');
  }
  if (feeRate <= 0) {
    throw new Error('Fee rate invalide: doit être positif');
  }
  if (feeRate > MAX_FEE_RATE) {
    throw new Error(
      `Fee rate trop élevé: ${feeRate} sats/vbyte > max ${MAX_FEE_RATE} sats/vbyte. ` +
      'Protection contre fee attack activée.'
    );
  }
}

/**
 * Vérifie si un locktime est valide et interprète sa signification.
 */
export function validateLocktime(locktime: number): {
  valid: boolean;
  type?: 'blockheight' | 'timestamp';
  value?: number;
  active?: boolean;
  error?: string;
} {
  if (typeof locktime !== 'number' || !Number.isInteger(locktime)) {
    return { valid: false, error: 'Locktime doit être un entier' };
  }

  if (locktime < 0) {
    return { valid: false, error: 'Locktime ne peut pas être négatif' };
  }

  if (locktime > MAX_LOCKTIME) {
    return { valid: false, error: 'Locktime dépasse la valeur maximale' };
  }

  // < 500000000 = block height, >= 500000000 = Unix timestamp
  if (locktime < 500000000) {
    return { valid: true, type: 'blockheight', value: locktime, active: false };
  } else {
    const timestamp = locktime * 1000;
    return { 
      valid: true, 
      type: 'timestamp', 
      value: locktime, 
      active: Date.now() >= timestamp 
    };
  }
}

/**
 * Vérifie si une séquence est finale ou active le locktime.
 */
export function interpretSequence(sequence: number): {
  final: boolean;
  locktimeEnabled: boolean;
  relativeLocktime?: number;
} {
  const final = sequence === SEQUENCE_FINAL;
  const locktimeEnabled = (sequence & ENABLE_LOCKTIME_MASK) !== SEQUENCE_FINAL;
  const relativeLocktime = locktimeEnabled ? sequence & ENABLE_LOCKTIME_MASK : undefined;

  return { final, locktimeEnabled, relativeLocktime };
}

function selectUtxos(utxos: MempoolUtxo[], targetAmount: number, feeRate: number): {
  selected: MempoolUtxo[];
  total: number;
  fee: number;
} {
  // Validation du fee rate (protection contre fee attack)
  validateFeeRate(feeRate);

  // Garde-fous : valeurs entières sûres (Bitcoin max ~2.1×10^15 sats < 2^53)
  if (!Number.isSafeInteger(targetAmount) || targetAmount <= 0) {
    throw new Error(`Montant invalide : ${targetAmount}`);
  }
  for (const utxo of utxos) {
    if (!Number.isSafeInteger(utxo.value) || utxo.value <= 0) {
      throw new Error(`Valeur UTXO invalide : ${utxo.txid}:${utxo.vout} = ${utxo.value}`);
    }
  }

  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const selected: MempoolUtxo[] = [];
  let total = 0;

  for (const utxo of sorted) {
    if (utxo.status.confirmed) {
      selected.push(utxo);
      total += utxo.value;

      const estimatedVbytes = 68 * selected.length + 31 * 2 + 11;
      const fee = Math.ceil(estimatedVbytes * feeRate);

      if (total >= targetAmount + fee + DUST_LIMIT) {
        return { selected, total, fee };
      }
    }
  }

  throw new Error('Fonds insuffisants');
}

const SCRIPTPUBKEY_FALLBACK_URLS = [
  'https://mempool.space/api',
  'https://blockstream.info/api',
];

const SCRIPTPUBKEY_FETCH_TIMEOUT_MS = 5000;

async function fetchUtxoScriptPubKey(txid: string, vout: number, primaryUrl: string = 'https://mempool.space/api'): Promise<string | null> {
  const candidates = [...new Set([primaryUrl, ...SCRIPTPUBKEY_FALLBACK_URLS])];
  for (const base of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCRIPTPUBKEY_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}/tx/${txid}`, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) continue;
      const tx = await response.json();
      const output = tx.vout?.[vout];
      if (output?.scriptpubkey) return output.scriptpubkey;
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        console.warn(`[BitcoinTx] Timeout sur ${base} pour ${txid}:${vout}`);
      }
      continue;
    }
  }
  console.error('[BitcoinTx] fetchUtxoScriptPubKey: échec sur tous les endpoints pour', txid, ':', vout);
  return null;
}

/**
 * Valide les outputs d'une transaction.
 * @throws si un output est invalide (dust, adresse invalide, etc.)
 */
export function validateOutputs(outputs: TxOutput[]): void {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error('Au moins un output requis');
  }

  for (const output of outputs) {
    // Vérifier le montant (pas de dust)
    if (typeof output.value !== 'number' || !Number.isSafeInteger(output.value)) {
      throw new Error(`Montant d'output invalide: ${output.value}`);
    }

    if (output.value < DUST_LIMIT) {
      throw new Error(
        `Output dust détecté: ${output.value} sats < ${DUST_LIMIT} sats minimum. ` +
        'Les outputs dust sont rejetés par le réseau Bitcoin.'
      );
    }

    // Vérifier l'adresse
    if (!output.address || typeof output.address !== 'string') {
      throw new Error('Adresse d\'output manquante ou invalide');
    }

    // Valider l'adresse avec checksum
    if (!validateAddress(output.address)) {
      throw new Error(`Adresse de destination invalide: ${output.address}`);
    }
  }
}

/**
 * Vérifie la validité d'une adresse de change.
 * Doit être une adresse SegWit du wallet.
 */
export function validateChangeAddress(changeAddress: string, derivedAddresses: DerivedAddress[]): void {
  if (!changeAddress || typeof changeAddress !== 'string') {
    throw new Error('Adresse de change manquante');
  }

  if (!validateAddress(changeAddress)) {
    throw new Error(`Adresse de change invalide: ${changeAddress}`);
  }

  // Vérifier que l'adresse de change appartient au wallet
  const isOurAddress = derivedAddresses.some(d => d.address === changeAddress);
  if (!isOurAddress) {
    console.warn('[BitcoinTx] Adresse de change non trouvée dans les adresses dérivées - vérification requise');
  }
}

export function createTransaction(
  utxos: MempoolUtxo[],
  toAddress: string,
  amountSats: number,
  changeAddress: string,
  feeRate: number,
  mnemonic?: string,
  options: {
    locktime?: number;
    sequence?: number;
  } = {}
): UnsignedTransaction {
  // Valider l'adresse de destination
  if (!validateAddress(toAddress)) {
    throw new Error(`Adresse de destination invalide: ${toAddress}`);
  }

  // Valider l'adresse de change
  if (!validateAddress(changeAddress)) {
    throw new Error(`Adresse de change invalide: ${changeAddress}`);
  }

  // Valider le fee rate
  validateFeeRate(feeRate);

  const { selected, total, fee } = selectUtxos(utxos, amountSats, feeRate);

  // Vérifier que le fee total ne dépasse pas la limite
  if (fee > MAX_TRANSACTION_FEE) {
    throw new Error(
      `Fee totale trop élevée: ${fee} sats > max ${MAX_TRANSACTION_FEE} sats. ` +
      'Protection contre fee attack.'
    );
  }

  const derivedAddresses = mnemonic ? deriveAddresses(mnemonic) : [];

  // Valider l'adresse de change si le wallet est disponible
  if (derivedAddresses.length > 0) {
    validateChangeAddress(changeAddress, derivedAddresses);
  }

  const psbt = new bitcoin.Psbt({ network: NETWORK });

  // Configurer le locktime si présent
  if (options.locktime !== undefined) {
    const locktimeValidation = validateLocktime(options.locktime);
    if (!locktimeValidation.valid) {
      throw new Error(`Locktime invalide: ${locktimeValidation.error}`);
    }
    psbt.setLocktime(options.locktime);
    console.log('[BitcoinTx] Locktime configuré:', options.locktime, locktimeValidation.type);
  }

  const inputs: TxInput[] = [];

  for (const utxo of selected) {
    let scriptPubKey: Buffer | null = null;

    // Chercher la clé dérivée correspondant à l'adresse de cet UTXO (fix : non plus premier blindly)
    if (derivedAddresses.length > 0 && utxo.address) {
      const derived = derivedAddresses.find(d => d.address === utxo.address);
      if (derived) {
        scriptPubKey = derived.scriptPubKey;
      }
    }

    if (!scriptPubKey) {
      // Fallback strict : utiliser l'adresse de l'UTXO uniquement (jamais changeAddress)
      if (!utxo.address) {
        throw new Error(`UTXO ${utxo.txid}:${utxo.vout} sans adresse — impossible de dériver le scriptPubKey`);
      }
      try {
        scriptPubKey = bitcoin.address.toOutputScript(utxo.address, NETWORK);
      } catch (_err) {
        throw new Error(`scriptPubKey invalide pour l'adresse ${utxo.address}`);
      }
    }

    // Configurer la séquence si locktime est actif
    const sequence = options.sequence ?? (options.locktime !== undefined ? ENABLE_LOCKTIME_MASK : SEQUENCE_FINAL);

    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: scriptPubKey,
        value: utxo.value,
      },
      sequence,
    });

    inputs.push({
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      scriptPubKey: scriptPubKey.toString('hex'),
    });
  }

  // Ajouter l'output principal
  psbt.addOutput({
    address: toAddress,
    value: amountSats,
  });

  const change = total - amountSats - fee;
  if (change > DUST_LIMIT) {
    psbt.addOutput({
      address: changeAddress,
      value: change,
    });
  }

  const psbtHex = psbt.toHex();

  // Valider les outputs
  const outputs: TxOutput[] = [
    { address: toAddress, value: amountSats },
    ...(change > DUST_LIMIT ? [{ address: changeAddress, value: change }] : []),
  ];
  validateOutputs(outputs);

  return {
    hex: psbtHex,
    txid: '',
    fee,
    inputs,
    outputs,
    locktime: options.locktime,
    version: 2,
  };
}

export async function createTransactionWithFetch(
  utxos: MempoolUtxo[],
  toAddress: string,
  amountSats: number,
  changeAddress: string,
  feeRate: number,
  mempoolUrl: string = 'https://mempool.space/api',
  options: {
    locktime?: number;
    sequence?: number;
  } = {}
): Promise<UnsignedTransaction> {
  // Valider l'adresse de destination
  if (!validateAddress(toAddress)) {
    throw new Error(`Adresse de destination invalide: ${toAddress}`);
  }

  // Valider l'adresse de change
  if (!validateAddress(changeAddress)) {
    throw new Error(`Adresse de change invalide: ${changeAddress}`);
  }

  // Valider le fee rate
  validateFeeRate(feeRate);

  const { selected, total, fee } = selectUtxos(utxos, amountSats, feeRate);

  // Vérifier que le fee total ne dépasse pas la limite
  if (fee > MAX_TRANSACTION_FEE) {
    throw new Error(
      `Fee totale trop élevée: ${fee} sats > max ${MAX_TRANSACTION_FEE} sats.`
    );
  }

  const psbt = new bitcoin.Psbt({ network: NETWORK });

  // Configurer le locktime si présent
  if (options.locktime !== undefined) {
    const locktimeValidation = validateLocktime(options.locktime);
    if (!locktimeValidation.valid) {
      throw new Error(`Locktime invalide: ${locktimeValidation.error}`);
    }
    psbt.setLocktime(options.locktime);
  }

  const inputs: TxInput[] = [];

  for (const utxo of selected) {
    let scriptPubKeyHex = await fetchUtxoScriptPubKey(utxo.txid, utxo.vout, mempoolUrl);

    if (!scriptPubKeyHex) {
      try {
        const script = bitcoin.address.toOutputScript(changeAddress, NETWORK);
        scriptPubKeyHex = script.toString('hex');
      } catch (_err) {
        throw new Error(`Cannot determine scriptPubKey for UTXO ${utxo.txid}:${utxo.vout}`);
      }
    }

    const scriptPubKey = Buffer.from(scriptPubKeyHex, 'hex');

    // Configurer la séquence si locktime est actif
    const sequence = options.sequence ?? (options.locktime !== undefined ? ENABLE_LOCKTIME_MASK : SEQUENCE_FINAL);

    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: scriptPubKey,
        value: utxo.value,
      },
      sequence,
    });

    inputs.push({
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      scriptPubKey: scriptPubKeyHex,
    });
  }

  psbt.addOutput({
    address: toAddress,
    value: amountSats,
  });

  const change = total - amountSats - fee;
  if (change > DUST_LIMIT) {
    psbt.addOutput({
      address: changeAddress,
      value: change,
    });
  }

  const psbtHex = psbt.toHex();

  // Valider les outputs
  const outputs: TxOutput[] = [
    { address: toAddress, value: amountSats },
    ...(change > DUST_LIMIT ? [{ address: changeAddress, value: change }] : []),
  ];
  validateOutputs(outputs);

  return {
    hex: psbtHex,
    txid: '',
    fee,
    inputs,
    outputs,
    locktime: options.locktime,
    version: 2,
  };
}

/**
 * Vérifie que tous les inputs d'un PSBT sont signés.
 * @returns {valid: boolean; unsignedInputs: number[]} - Indices des inputs non signés
 */
export function verifyAllInputsSigned(psbtHex: string): { valid: boolean; unsignedInputs: number[] } {
  try {
    const psbt = bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK });
    const unsignedInputs: number[] = [];

    for (let i = 0; i < psbt.inputCount; i++) {
      const input = psbt.data.inputs[i];
      
      // Vérifier si l'input a une signature
      const hasSignature = 
        (input.finalScriptSig && input.finalScriptSig.length > 0) ||
        (input.finalScriptWitness && input.finalScriptWitness.length > 0) ||
        (input.partialSig && input.partialSig.length > 0);

      if (!hasSignature) {
        unsignedInputs.push(i);
      }
    }

    return { valid: unsignedInputs.length === 0, unsignedInputs };
  } catch (err) {
    console.error('[BitcoinTx] Erreur vérification signatures:', err);
    return { valid: false, unsignedInputs: [] };
  }
}

/**
 * Vérifie la validité d'un PSBT avant finalisation.
 */
export function validatePsbt(psbtHex: string): {
  valid: boolean;
  error?: string;
  warnings?: string[];
} {
  const warnings: string[] = [];

  try {
    const psbt = bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK });

    // Vérifier qu'il y a au moins un input et un output
    if (psbt.inputCount === 0) {
      return { valid: false, error: 'PSBT sans input' };
    }

    if (psbt.txOutputs.length === 0) {
      return { valid: false, error: 'PSBT sans output' };
    }

    // Vérifier les outputs (pas de dust)
    for (let i = 0; i < psbt.txOutputs.length; i++) {
      const output = psbt.txOutputs[i];
      if (output.value < DUST_LIMIT) {
        return { valid: false, error: `Output ${i} est du dust: ${output.value} sats` };
      }
    }

    // Vérifier le locktime s'il est présent
    if (psbt.locktime !== 0) {
      const locktimeValidation = validateLocktime(psbt.locktime);
      if (!locktimeValidation.valid) {
        return { valid: false, error: `Locktime invalide: ${locktimeValidation.error}` };
      }
      if (locktimeValidation.type === 'timestamp' && locktimeValidation.active) {
        warnings.push(`Locktime timestamp actif: ${psbt.locktime}`);
      } else if (locktimeValidation.type === 'blockheight') {
        warnings.push(`Locktime block height: ${psbt.locktime}`);
      }
    }

    // Vérifier que tous les inputs ont des witnessUtxo
    for (let i = 0; i < psbt.inputCount; i++) {
      const input = psbt.data.inputs[i];
      if (!input.witnessUtxo) {
        warnings.push(`Input ${i} n'a pas de witnessUtxo`);
      }
    }

    return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
  } catch (err) {
    return { valid: false, error: `PSBT invalide: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

export async function signTransaction(
  psbtHex: string,
  mnemonic: string,
  _utxos: MempoolUtxo[]
): Promise<string> {
  // Valider le PSBT avant signature
  const psbtValidation = validatePsbt(psbtHex);
  if (!psbtValidation.valid) {
    throw new Error(`PSBT invalide: ${psbtValidation.error}`);
  }

  // Déclaré en dehors du try pour être accessible dans le finally (effacement mémoire)
  const derivedKeys: Array<{ index: number; publicKey: Uint8Array; privateKey: Uint8Array; scriptPubKey: Buffer }> = [];
  try {
    const psbt = bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK });

    const seed = mnemonicToSeed(mnemonic);
    const masterKey = HDKey.fromMasterSeed(seed);
    const accountKey = masterKey.derive("m/84'/0'/0'");
    for (let i = 0; i < MAX_ADDRESS_SCAN; i++) {
      const child = accountKey.deriveChild(0).deriveChild(i);
      if (child.publicKey && child.privateKey) {
        const h160 = hash160(child.publicKey);
        const scriptPubKey = Buffer.alloc(22);
        scriptPubKey[0] = 0x00;
        scriptPubKey[1] = 0x14;
        Buffer.from(h160).copy(scriptPubKey, 2);

        derivedKeys.push({
          index: i,
          publicKey: child.publicKey,
          privateKey: child.privateKey,
          scriptPubKey,
        });
      }
    }

    for (let changeIdx = 0; changeIdx < MAX_ADDRESS_SCAN; changeIdx++) {
      const child = accountKey.deriveChild(1).deriveChild(changeIdx);
      if (child.publicKey && child.privateKey) {
        const h160 = hash160(child.publicKey);
        const scriptPubKey = Buffer.alloc(22);
        scriptPubKey[0] = 0x00;
        scriptPubKey[1] = 0x14;
        Buffer.from(h160).copy(scriptPubKey, 2);

        derivedKeys.push({
          index: 100 + changeIdx,
          publicKey: child.publicKey,
          privateKey: child.privateKey,
          scriptPubKey,
        });
      }
    }

    for (let i = 0; i < psbt.inputCount; i++) {
      const input = psbt.data.inputs[i];
      const inputScript = input.witnessUtxo?.script;

      let signed = false;

      for (const key of derivedKeys) {
        if (inputScript && key.scriptPubKey.equals(inputScript)) {
          const signer = {
            publicKey: Buffer.from(key.publicKey),
            sign: (hash: Buffer) => {
              const sig = secp256k1.ecdsaSign(
                new Uint8Array(hash),
                key.privateKey
              );
              return Buffer.from(sig.signature);
            },
          };

          psbt.signInput(i, signer);
          signed = true;
          console.log('[BitcoinTx] Input', i, 'signed with key index:', key.index);
          break;
        }
      }

      if (!signed) {
        // Tronquer le scriptPubKey pour éviter la fuite de données sensibles dans les logs
        const scriptHint = inputScript ? inputScript.toString('hex').slice(0, 16) + '…' : 'inconnu';
        throw new Error(
          `Input ${i} : aucune clé HD correspondante (script: ${scriptHint}). ` +
          `Vérifiez que les UTXOs appartiennent à ce wallet (gap limit = ${MAX_ADDRESS_SCAN}).`
        );
      }
    }

    // Vérifier que tous les inputs sont signés avant finalisation
    const signedCheck = verifyAllInputsSigned(psbtHex);
    if (!signedCheck.valid) {
      throw new Error(`Inputs non signés: ${signedCheck.unsignedInputs.join(', ')}`);
    }

    psbt.finalizeAllInputs();

    const tx = psbt.extractTransaction();
    const txHex = tx.toHex();
    console.log('[BitcoinTx] Transaction signed, txid:', tx.getId());
    return txHex;

  } catch (error) {
    console.error('[BitcoinTx] Erreur signature:', error);
    throw new Error(`Signature échouée: ${error}`);
  } finally {
    // Effacer systématiquement les clés privées de la mémoire (succès OU erreur)
    for (const key of derivedKeys) {
      key.privateKey.fill(0);
    }
    derivedKeys.length = 0;
  }
}

export function estimateFee(
  numInputs: number,
  numOutputs: number,
  feeRate: number
): number {
  // Valider le fee rate
  validateFeeRate(feeRate);

  const vbytes = 68 * numInputs + 31 * numOutputs + 11;
  const fee = Math.ceil(vbytes * feeRate);

  // Vérifier la limite max
  if (fee > MAX_TRANSACTION_FEE) {
    throw new Error(`Fee estimée trop élevée: ${fee} sats > ${MAX_TRANSACTION_FEE} sats`);
  }

  return fee;
}

export function validateAddress(address: string): boolean {
  try {
    bitcoin.address.toOutputScript(address, NETWORK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Vérifie si une transaction utilise le RBF (Replace-By-Fee).
 */
export function isRbfEnabled(psbtHex: string): boolean {
  try {
    const psbt = bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK });
    
    for (let i = 0; i < psbt.inputCount; i++) {
      const input = psbt.data.inputs[i];
      const seq = (input as any).sequence;
      if (seq !== undefined && seq < SEQUENCE_FINAL) {
        // Si le LSB n'est pas set (0xffffffff >> 1), RBF est possible
        if ((seq & ENABLE_LOCKTIME_MASK) !== SEQUENCE_FINAL) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Active le RBF (Replace-By-Fee) sur tous les inputs d'une transaction.
 */
export function enableRbf(psbtHex: string): string {
  try {
    const psbt = bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK });
    
    for (let i = 0; i < psbt.inputCount; i++) {
      const input = psbt.data.inputs[i];
      // Set sequence to 0xfffffffd to enable RBF
      const currentSequence = (input as any).sequence ?? SEQUENCE_FINAL;
      if (currentSequence === SEQUENCE_FINAL) {
        psbt.updateInput(i, { sequence: ENABLE_LOCKTIME_MASK - 2 } as any);
      }
    }
    
    return psbt.toHex();
  } catch (err) {
    throw new Error(`Impossible d'activer RBF: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}
