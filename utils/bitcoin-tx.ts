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

function selectUtxos(utxos: MempoolUtxo[], targetAmount: number, feeRate: number): {
  selected: MempoolUtxo[];
  total: number;
  fee: number;
} {
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

async function fetchUtxoScriptPubKey(txid: string, vout: number, primaryUrl: string = 'https://mempool.space/api'): Promise<string | null> {
  const candidates = [...new Set([primaryUrl, ...SCRIPTPUBKEY_FALLBACK_URLS])];
  for (const base of candidates) {
    try {
      const response = await fetch(`${base}/tx/${txid}`);
      if (!response.ok) continue;
      const tx = await response.json();
      const output = tx.vout?.[vout];
      if (output?.scriptpubkey) return output.scriptpubkey;
    } catch {
      continue;
    }
  }
  console.error('[BitcoinTx] fetchUtxoScriptPubKey: échec sur tous les endpoints pour', txid, ':', vout);
  return null;
}

export function createTransaction(
  utxos: MempoolUtxo[],
  toAddress: string,
  amountSats: number,
  changeAddress: string,
  feeRate: number,
  mnemonic?: string
): UnsignedTransaction {
  const { selected, total, fee } = selectUtxos(utxos, amountSats, feeRate);

  const derivedAddresses = mnemonic ? deriveAddresses(mnemonic) : [];

  const psbt = new bitcoin.Psbt({ network: NETWORK });

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
      // Fallback : dériver le script depuis l'adresse UTXO connue ou l'adresse de change
      const addrForScript = utxo.address ?? changeAddress;
      try {
        scriptPubKey = bitcoin.address.toOutputScript(addrForScript, NETWORK);
      } catch (_err) {
        throw new Error(`Impossible de dériver le scriptPubKey pour l'UTXO ${utxo.txid}:${utxo.vout} (adresse: ${addrForScript})`);
      }
    }

    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: scriptPubKey,
        value: utxo.value,
      },
    });

    inputs.push({
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      scriptPubKey: scriptPubKey.toString('hex'),
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

  return {
    hex: psbtHex,
    txid: '',
    fee,
    inputs,
    outputs: [
      { address: toAddress, value: amountSats },
      ...(change > DUST_LIMIT ? [{ address: changeAddress, value: change }] : []),
    ],
  };
}

export async function createTransactionWithFetch(
  utxos: MempoolUtxo[],
  toAddress: string,
  amountSats: number,
  changeAddress: string,
  feeRate: number,
  mempoolUrl: string = 'https://mempool.space/api'
): Promise<UnsignedTransaction> {
  const { selected, total, fee } = selectUtxos(utxos, amountSats, feeRate);

  const psbt = new bitcoin.Psbt({ network: NETWORK });
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

    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: scriptPubKey,
        value: utxo.value,
      },
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

  return {
    hex: psbtHex,
    txid: '',
    fee,
    inputs,
    outputs: [
      { address: toAddress, value: amountSats },
      ...(change > DUST_LIMIT ? [{ address: changeAddress, value: change }] : []),
    ],
  };
}

export async function signTransaction(
  psbtHex: string,
  mnemonic: string,
  _utxos: MempoolUtxo[]
): Promise<string> {
  try {
    const psbt = bitcoin.Psbt.fromHex(psbtHex, { network: NETWORK });

    const seed = mnemonicToSeed(mnemonic);
    const masterKey = HDKey.fromMasterSeed(seed);
    const accountKey = masterKey.derive("m/84'/0'/0'");

    const derivedKeys: Array<{ index: number; publicKey: Uint8Array; privateKey: Uint8Array; scriptPubKey: Buffer }> = [];
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
        throw new Error(
          `Input ${i} : aucune clé HD correspondante. scriptPubKey=${inputScript?.toString('hex') ?? 'inconnu'}. ` +
          `Vérifiez que les UTXOs appartiennent bien à ce wallet (gap limit = ${MAX_ADDRESS_SCAN}).`
        );
      }
    }

    psbt.finalizeAllInputs();

    const tx = psbt.extractTransaction();
    console.log('[BitcoinTx] Transaction signed, txid:', tx.getId());
    return tx.toHex();

  } catch (error) {
    console.error('[BitcoinTx] Erreur signature:', error);
    throw new Error(`Signature échouée: ${error}`);
  }
}

export function estimateFee(
  numInputs: number,
  numOutputs: number,
  feeRate: number
): number {
  const vbytes = 68 * numInputs + 31 * numOutputs + 11;
  return Math.ceil(vbytes * feeRate);
}

export function validateAddress(address: string): boolean {
  try {
    bitcoin.address.toOutputScript(address, NETWORK);
    return true;
  } catch {
    return false;
  }
}
