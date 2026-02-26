import { useState } from 'react';
import createContextHook from '@nkzw/create-context-hook';

export interface MempoolUtxo {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

export interface MempoolFeeEstimates {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

export interface BitcoinTransaction {
  txid: string;
  amount: number;
  type: 'incoming' | 'outgoing';
  confirmed: boolean;
  timestamp?: number;
  fee?: number;
}

export interface BitcoinState {
  balance: number;
  unconfirmedBalance: number;
  utxos: MempoolUtxo[];
  transactions: BitcoinTransaction[];
  feeEstimates: MempoolFeeEstimates | null;
  isLoading: boolean;
  lastSync: number | null;
  error: string | null;
  refreshBalance: () => Promise<void>;
  sendBitcoin: (toAddress: string, amountSats: number, feeRate: number) => Promise<{ txid: string; hex: string }>;
  estimateSendFee: (amountSats: number, feeRate: number) => number;
}

const noopAsync = async () => {
  console.log('[Bitcoin-Web] Not available on web');
};

export const [BitcoinContext, useBitcoin] = createContextHook((): BitcoinState => {
  const [balance] = useState(0);
  const [utxos] = useState<MempoolUtxo[]>([]);
  const [transactions] = useState<BitcoinTransaction[]>([]);

  return {
    balance,
    unconfirmedBalance: 0,
    utxos,
    transactions,
    feeEstimates: null,
    isLoading: false,
    lastSync: null,
    error: 'Bitcoin wallet not available on web',
    refreshBalance: noopAsync,
    sendBitcoin: async () => { throw new Error('Not available on web'); },
    estimateSendFee: () => 0,
  };
});
