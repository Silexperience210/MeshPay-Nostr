/**
 * useWalletHermes - Hook d'intégration Wallet avec Hermès Engine
 * 
 * Remplace: useWalletSeed() - Wallet + génération
 * 
 * Ce hook wrap useWalletStore et émet des événements Hermès
 * quand le wallet change d'état.
 */

import { useEffect, useCallback, useMemo } from 'react';
import { hermes } from '../HermesEngine';
import { EventType, Transport } from '../types';
import { EventBuilder } from '../utils/EventBuilder';
import { 
  useWalletStore, 
  useWalletInitialized,
  useWalletLoading,
  useWalletInfo,
  useWalletAddresses,
} from '@/stores/walletStore';
import type { DerivedWalletInfo } from '@/utils/bitcoin';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UseWalletHermesReturn {
  // ─── State du Wallet ────────────────────────────────────────────────────────
  /** Wallet initialisé (possède un mnemonic) */
  isInitialized: boolean;
  /** Données en cours de chargement depuis SecureStore */
  isLoading: boolean;
  /** Génération en cours */
  isGenerating: boolean;
  /** Import en cours */
  isImporting: boolean;
  /** Erreur de génération */
  generateError: Error | null;
  /** Erreur d'import */
  importError: Error | null;
  /** Info du wallet dérivé (nodeId, xpub, etc.) */
  walletInfo: DerivedWalletInfo | null;
  /** Adresses de réception */
  receiveAddresses: string[];
  /** Adresses de change */
  changeAddresses: string[];
  /** Première adresse de réception formatée pour l'affichage */
  formattedAddress: string;
  
  // ─── Actions ────────────────────────────────────────────────────────────────
  /** Générer un nouveau wallet */
  generateWallet: (strength?: 12 | 24) => Promise<void>;
  /** Importer un wallet depuis une phrase mnémonique */
  importWallet: (mnemonic: string) => Promise<void>;
  /** Supprimer le wallet (⚠️ irréversible) */
  deleteWallet: () => Promise<void>;
  /** Exporter le wallet chiffré */
  exportWallet: (password: string) => Promise<string>;
  /** Importer un wallet chiffré */
  importEncryptedWallet: (backupJson: string, password: string) => Promise<void>;
  
  // ─── Hermès Integration ─────────────────────────────────────────────────────
  /** Émettre manuellement l'événement WALLET_INITIALIZED */
  emitWalletReady: () => void;
  /** Node ID pour les communications Nostr/LoRa */
  nodeId: string | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useWalletHermes(): UseWalletHermesReturn {
  // ─── State depuis Zustand ───────────────────────────────────────────────────
  const store = useWalletStore();
  const isInitialized = useWalletInitialized();
  const isLoading = useWalletLoading();
  const walletInfo = useWalletInfo();
  const { receiveAddresses, changeAddresses } = useWalletAddresses();
  
  // ─── Effet: Émettre événements Hermès ───────────────────────────────────────
  // NOTE: Désactivé pour éviter la triple émission. L'événement est déjà émis par:
  // 1. UnifiedIdentityManager.createIdentity() (source principale)
  // useEffect(() => {
  //   if (isInitialized && walletInfo) {
  //     const event = EventBuilder.system()
  //       .type(EventType.WALLET_INITIALIZED)
  //       .raw({ nodeId: walletInfo.nodeId, npub: walletInfo.nostrPubkey })
  //       .build();
  //     hermes.emit(event, Transport.INTERNAL).catch(console.error);
  //   }
  // }, [isInitialized, walletInfo]);
  
  // ─── Actions wrapper ────────────────────────────────────────────────────────
  
  const generateWallet = useCallback(async (strength?: 12 | 24): Promise<void> => {
    await store.generateWallet(strength);
    // L'événement sera émis automatiquement par l'effet ci-dessus
  }, [store]);
  
  const importWallet = useCallback(async (mnemonic: string): Promise<void> => {
    await store.importWallet(mnemonic);
  }, [store]);
  
  const deleteWallet = useCallback(async (): Promise<void> => {
    await store.deleteWallet();
    
    // Émettre événement de suppression
    const event = EventBuilder.system()
      .type(EventType.WALLET_DELETED)
      .raw({ timestamp: Date.now() })
      .build();
    
    await hermes.emit(event, Transport.INTERNAL);
  }, [store]);
  
  const exportWallet = useCallback(async (password: string): Promise<string> => {
    // Import dynamique pour éviter les problèmes de polyfill
    const { exportWalletEncrypted } = await import('@/stores/walletStore');
    const mnemonic = store.mnemonic;
    
    if (!mnemonic) {
      throw new Error('Aucun wallet à exporter');
    }
    
    return exportWalletEncrypted(mnemonic, password);
  }, [store.mnemonic]);
  
  const importEncryptedWallet = useCallback(async (
    backupJson: string, 
    password: string
  ): Promise<void> => {
    await store.importEncryptedWallet(backupJson, password);
  }, [store]);
  
  // ─── Helpers ────────────────────────────────────────────────────────────────
  
  const emitWalletReady = useCallback((): void => {
    if (walletInfo) {
      const event = EventBuilder.system()
        .type(EventType.WALLET_INITIALIZED)
        .raw({
          nodeId: walletInfo.nodeId,
          npub: walletInfo.nostrPubkey,
        })
        .build();
      
      hermes.emit(event, Transport.INTERNAL).catch(console.error);
    }
  }, [walletInfo]);
  
  const formattedAddress = useMemo((): string => {
    if (walletInfo?.firstReceiveAddress) {
      const addr = walletInfo.firstReceiveAddress;
      return addr.slice(0, 6) + '...' + addr.slice(-4);
    }
    return 'No wallet';
  }, [walletInfo]);
  
  const nodeId = walletInfo?.nodeId || null;
  
  // ─── Return ─────────────────────────────────────────────────────────────────
  
  return {
    // State
    isInitialized,
    isLoading,
    isGenerating: store.isGenerating,
    isImporting: store.isImporting,
    generateError: store.generateError,
    importError: store.importError,
    walletInfo,
    receiveAddresses,
    changeAddresses,
    formattedAddress,
    
    // Actions
    generateWallet,
    importWallet,
    deleteWallet,
    exportWallet,
    importEncryptedWallet,
    
    // Hermès
    emitWalletReady,
    nodeId,
  };
}

export default useWalletHermes;
