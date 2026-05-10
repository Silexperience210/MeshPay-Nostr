import type { MempoolUtxo } from './mempool';

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

export function validateAddress(address: string): boolean {
  if (!address || address.length < 26 || address.length > 62) return false;
  if (/^(1|3)[a-zA-HJ-NP-Z0-9]{25,34}$/.test(address)) return true;
  if (/^bc1[a-z0-9]{6,87}$/.test(address)) return true;
  return false;
}

export function estimateFee(numInputs: number, numOutputs: number, feeRate: number): number {
  const vbytes = 68 * numInputs + 31 * numOutputs + 11;
  return Math.ceil(vbytes * feeRate);
}

export function createTransaction(
  _utxos: MempoolUtxo[],
  _toAddress: string,
  _amountSats: number,
  _changeAddress: string,
  _feeRate: number,
  _mnemonic?: string
): UnsignedTransaction {
  throw new Error('createTransaction not available on web');
}

export async function createTransactionWithFetch(
  _utxos: MempoolUtxo[],
  _toAddress: string,
  _amountSats: number,
  _changeAddress: string,
  _feeRate: number,
  _mempoolUrl?: string
): Promise<UnsignedTransaction> {
  throw new Error('createTransactionWithFetch not available on web');
}

export async function signTransaction(
  _psbtHex: string,
  _mnemonic: string,
  _utxos: MempoolUtxo[]
): Promise<string> {
  throw new Error('signTransaction not available on web');
}
