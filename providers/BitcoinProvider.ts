/**
 * BitcoinProvider - Gestion du wallet Bitcoin via mempool.space
 * Solde, UTXOs, historique, envoi de transactions
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import createContextHook from '@nkzw/create-context-hook';
import { useWalletStore } from '@/stores/walletStore';
import {
  getAddressUtxos,
  getAddressBalance,
  getFeeEstimates,
  broadcastTransaction,
  getAddressTransactions,
  type MempoolUtxo,
  type MempoolFeeEstimates,
} from '@/utils/mempool';
import { createTransactionWithFetch, estimateFee, validateAddress, signTransaction } from '@/utils/bitcoin-tx';
import { sendBitcoinTxViaNostr, isTxAlreadyKnown } from '@/utils/tx-relay';

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

export const [BitcoinContext, useBitcoin] = createContextHook((): BitcoinState => {
  const walletInfo = useWalletStore((s) => s.walletInfo);
  const receiveAddresses = useWalletStore((s) => s.receiveAddresses);
  const changeAddresses = useWalletStore((s) => s.changeAddresses);
  const isInitialized = useWalletStore((s) => s.isInitialized);
  const mnemonic = useWalletStore((s) => s.mnemonic);
  
  const [balance, setBalance] = useState(0);
  const [unconfirmedBalance, setUnconfirmedBalance] = useState(0);
  const [utxos, setUtxos] = useState<MempoolUtxo[]>([]);
  const [transactions, setTransactions] = useState<BitcoinTransaction[]>([]);
  const [feeEstimates, setFeeEstimates] = useState<MempoolFeeEstimates | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const syncIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mutex anti double-envoi : empêche deux transactions simultanées sur les mêmes UTXOs
  const isSendingRef = useRef(false);
  // Index change address : incrémenter à chaque tx pour éviter la réutilisation d'adresse
  const changeIndexRef = useRef(0);

  /**
   * Rafraîchit le solde et les UTXOs
   */
  const refreshBalance = useCallback(async () => {
    if (!isInitialized || !receiveAddresses.length) {
      console.log('[Bitcoin] Wallet non initialisé, skip sync');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Inclure TOUTES les adresses (receive m/84'/0'/0'/0/i + change m/84'/0'/0'/1/i)
      const allAddresses = [...receiveAddresses, ...changeAddresses];
      console.log('[Bitcoin] Sync', allAddresses.length, 'adresses (', receiveAddresses.length, 'receive +', changeAddresses.length, 'change)...');

      const [balancesData, utxosData, feesData, txsPerAddr] = await Promise.all([
        Promise.all(allAddresses.map(addr => getAddressBalance(addr))),
        Promise.all(allAddresses.map(addr => getAddressUtxos(addr))),
        getFeeEstimates(),
        Promise.all(allAddresses.map(addr => getAddressTransactions(addr).catch(() => [] as any[]))),
      ]);

      const totalConfirmed = balancesData.reduce((sum, b) => sum + b.confirmed, 0);
      const totalUnconfirmed = balancesData.reduce((sum, b) => sum + b.unconfirmed, 0);
      const allUtxos = utxosData.flat();

      // Dédupliquer les transactions par txid (une tx peut apparaître dans plusieurs adresses)
      const txMap = new Map<string, any>();
      txsPerAddr.flat().forEach(tx => { if (tx?.txid) txMap.set(tx.txid, tx); });
      const rawTxs = Array.from(txMap.values());

      const mappedTxs: BitcoinTransaction[] = rawTxs.map((tx: any) => {
        const received = (tx.vout ?? []).reduce((sum: number, o: any) => {
          if (allAddresses.includes(o.scriptpubkey_address)) return sum + (o.value ?? 0);
          return sum;
        }, 0);
        const spent = (tx.vin ?? []).reduce((sum: number, inp: any) => {
          if (allAddresses.includes(inp.prevout?.scriptpubkey_address)) return sum + (inp.prevout?.value ?? 0);
          return sum;
        }, 0);
        const net = received - spent;
        return {
          txid: tx.txid,
          amount: Math.abs(net),
          type: net >= 0 ? 'incoming' : 'outgoing',
          confirmed: tx.status?.confirmed ?? false,
          timestamp: tx.status?.block_time,
          fee: tx.fee,
        };
      });

      setBalance(totalConfirmed);
      setUnconfirmedBalance(totalUnconfirmed);
      setUtxos(allUtxos);
      setTransactions(mappedTxs);
      setFeeEstimates(feesData);
      setLastSync(Date.now());

      console.log('[Bitcoin] Sync OK - Solde:', totalConfirmed, 'sats -', allUtxos.length, 'UTXOs -', mappedTxs.length, 'txs');
    } catch (err) {
      console.error('[Bitcoin] Erreur sync:', err);
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  }, [isInitialized, receiveAddresses, changeAddresses]);

  /**
   * Estime les frais pour un envoi
   */
  const estimateSendFee = useCallback((amountSats: number, feeRate: number): number => {
    // Sélectionner les UTXOs nécessaires
    let totalNeeded = amountSats;
    let numInputs = 0;
    let selectedValue = 0;
    
    for (const utxo of utxos.filter(u => u.status.confirmed).sort((a, b) => b.value - a.value)) {
      selectedValue += utxo.value;
      numInputs++;
      
      const fee = estimateFee(numInputs, 2, feeRate);
      if (selectedValue >= amountSats + fee) {
        return fee;
      }
    }
    
    return estimateFee(1, 2, feeRate); // Estimation par défaut
  }, [utxos]);

  /**
   * Envoie des bitcoins
   * Retourne la transaction hex (à signer manuellement pour l'instant)
   */
  const sendBitcoin = useCallback(async (
    toAddress: string,
    amountSats: number,
    feeRate: number
  ): Promise<{ txid: string; hex: string }> => {
    if (!isInitialized || !receiveAddresses.length || !mnemonic) {
      throw new Error('Wallet non initialisé');
    }

    // Mutex : bloque un second envoi pendant que le premier est en cours
    if (isSendingRef.current) {
      throw new Error('Un envoi est déjà en cours, veuillez patienter');
    }
    isSendingRef.current = true;

    try {
      if (!validateAddress(toAddress)) {
        throw new Error('Adresse invalide');
      }

      if (amountSats <= 0) {
        throw new Error('Montant invalide');
      }

      // Snapshot du solde au moment du lock (évite la TOCTOU)
      const currentBalance = balance;
      if (amountSats > currentBalance) {
        throw new Error('Solde insuffisant');
      }

      // Change address avec index incrémental (évite la réutilisation d'adresse)
      const changeIdx = changeIndexRef.current % (changeAddresses?.length || 1);
      const changeAddr = changeAddresses?.[changeIdx] ?? receiveAddresses[0];

      console.log('[Bitcoin] Création transaction:', {
        to: toAddress,
        amount: amountSats,
        feeRate,
        changeAddr: `index ${changeIdx}`,
      });

      const unsignedTx = await createTransactionWithFetch(
        utxos,
        toAddress,
        amountSats,
        changeAddr,
        feeRate,
      );

      console.log('[Bitcoin] Transaction créée:', unsignedTx.txid);
      console.log('[Bitcoin] Frais:', unsignedTx.fee);

      // Signer la transaction
      const signedHex = await signTransaction(unsignedTx.hex, mnemonic, utxos);

      // Broadcast (direct ou via relay Nostr si hors ligne)
      let txid: string;
      try {
        const result = await broadcastTransaction(signedHex);
        txid = result.txid;
        console.log('[Bitcoin] Transaction broadcastée:', txid);
      } catch (broadcastErr) {
        // TX déjà dans la mempool = succès silencieux
        if (broadcastErr instanceof Error && isTxAlreadyKnown(broadcastErr)) {
          console.log('[Bitcoin] TX déjà connue du réseau — succès idempotent');
          txid = unsignedTx.txid;
        } else {
          // Erreur réseau → tenter le relay via Nostr (nœud hors ligne)
          const isNetworkFailure = broadcastErr instanceof Error && (
            broadcastErr.message.toLowerCase().includes('network') ||
            broadcastErr.message.toLowerCase().includes('failed to fetch') ||
            broadcastErr.message.toLowerCase().includes('fetch') ||
            broadcastErr.message.toLowerCase().includes('enotreachable') ||
            broadcastErr.message.toLowerCase().includes('etimedout')
          );
          if (isNetworkFailure) {
            console.log('[Bitcoin] Réseau inaccessible — relay via Nostr...');
            try {
              const relayResult = await sendBitcoinTxViaNostr(signedHex, { timeoutMs: 90_000 });
              txid = relayResult.txid ?? unsignedTx.txid;
              console.log('[Bitcoin] TX relayée via Nostr gateway:', txid);
            } catch (relayErr) {
              // Relay aussi échoué — remonter l'erreur originale (plus parlante)
              throw broadcastErr;
            }
          } else {
            // Erreur Bitcoin (TX invalide, UTXO déjà dépensé, etc.) → pas de relay
            throw broadcastErr;
          }
        }
      }

      // Incrémenter l'index de change après succès
      changeIndexRef.current += 1;

      // Rafraîchir le solde
      await refreshBalance();

      return { txid, hex: signedHex };

    } catch (error) {
      console.error('[Bitcoin] Erreur création transaction:', error);
      throw error;
    } finally {
      isSendingRef.current = false;
    }
  }, [isInitialized, receiveAddresses, changeAddresses, mnemonic, balance, utxos, refreshBalance]);

  // Sync au montage
  useEffect(() => {
    if (isInitialized) {
      refreshBalance();
    }
  }, [isInitialized, refreshBalance]);

  // Sync périodique
  useEffect(() => {
    if (isInitialized) {
      syncIntervalRef.current = setInterval(() => {
        refreshBalance();
      }, 2 * 60 * 1000);
    }

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
      }
    };
  }, [isInitialized, refreshBalance]);

  return {
    balance,
    unconfirmedBalance,
    utxos,
    transactions,
    feeEstimates,
    isLoading,
    lastSync,
    error,
    refreshBalance,
    sendBitcoin,
    estimateSendFee,
  };
});
