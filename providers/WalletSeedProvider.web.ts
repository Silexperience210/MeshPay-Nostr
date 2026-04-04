import { useState, useEffect, useCallback } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import createContextHook from '@nkzw/create-context-hook';
// @ts-ignore - subpath exports
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
// @ts-ignore - subpath exports
import { sha256 } from '@noble/hashes/sha2.js';
// @ts-ignore - subpath exports
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes';
import {
  generateMnemonic,
  validateMnemonic,
  deriveWalletInfo,
  deriveReceiveAddresses,
  shortenAddress,
  DerivedWalletInfo,
} from '@/utils/bitcoin';
import { logger } from '@/utils/logger';

const MNEMONIC_KEY = 'meshcore_wallet_mnemonic_encrypted';
const WALLET_INITIALIZED_KEY = 'meshcore_wallet_initialized';
const SALT_KEY = 'meshcore_wallet_salt';

// ─── Constantes de chiffrement ───────────────────────────────────────────────
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits pour AES-256-GCM

interface EncryptedWallet {
  /** Version du format */
  v: 1;
  /** IV AES-GCM hex (12 bytes) */
  iv: string;
  /** Mnemonic chiffré + tag GCM hex */
  ct: string;
}

// ─── Fonctions de chiffrement Web Crypto API ─────────────────────────────────

/**
 * Dérive une clé de chiffrement à partir d'un mot de passe et d'un sel
 * en utilisant PBKDF2 via Web Crypto API.
 * 
 * SÉCURITÉ:
 * - PBKDF2 avec 100k itérations minimum (OWASP recommendation)
 * - Sel aléatoire de 32 bytes unique par wallet
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  
  // Importer le mot de passe comme clé brute
  const baseKey = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  
  // Dériver la clé avec PBKDF2
  // Note: Le sel doit être BufferSource (Uint8Array est compatible)
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: KEY_LENGTH * 8 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Chiffre le mnemonic avec Web Crypto API (AES-256-GCM).
 * 
 * SÉCURITÉ (Fix VULN-006):
 * - Le mnemonic n'est JAMAIS stocké en clair dans localStorage
 * - Chiffrement AES-256-GCM avec authentification intégrée
 * - PBKDF2 avec 100k itérations et sel unique
 * 
 * @param mnemonic - Phrase mnémonique à chiffrer
 * @param password - Mot de passe de dérivation
 * @returns JSON string contenant le sel, IV et ciphertext
 */
async function encryptMnemonic(mnemonic: string, password: string): Promise<string> {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  
  const key = await deriveKey(password, salt);
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(mnemonic);
  
  // Convertir IV en ArrayBuffer pour Web Crypto API
  const ivBuffer = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
  
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBuffer },
    key,
    plaintext
  );
  
  const encrypted: EncryptedWallet = {
    v: 1,
    iv: bytesToHex(iv),
    ct: bytesToHex(new Uint8Array(ciphertext)),
  };
  
  // Stocker le sel séparément (ou l'inclure dans l'objet chiffré)
  const result = {
    salt: bytesToHex(salt),
    encrypted,
  };
  
  return JSON.stringify(result);
}

/**
 * Déchiffre le mnemonic avec Web Crypto API.
 * 
 * @throws Si le mot de passe est incorrect ou le format invalide
 */
async function decryptMnemonic(encryptedJson: string, password: string): Promise<string> {
  let data: { salt: string; encrypted: EncryptedWallet };
  
  try {
    data = JSON.parse(encryptedJson);
  } catch {
    throw new Error('Format de données chiffrées invalide');
  }
  
  const { salt, encrypted } = data;
  
  if (!salt || !encrypted?.iv || !encrypted?.ct) {
    throw new Error('Données chiffrées incomplètes');
  }
  
  const key = await deriveKey(password, hexToBytes(salt));
  
  try {
    const ivBytes = hexToBytes(encrypted.iv);
    const ivBuffer = ivBytes.buffer.slice(ivBytes.byteOffset, ivBytes.byteOffset + ivBytes.byteLength) as ArrayBuffer;
    
    const ctBytes = hexToBytes(encrypted.ct);
    const ctBuffer = ctBytes.buffer.slice(ctBytes.byteOffset, ctBytes.byteOffset + ctBytes.byteLength) as ArrayBuffer;
    
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBuffer },
      key,
      ctBuffer
    );
    
    const decoder = new TextDecoder();
    return decoder.decode(plaintext);
  } catch {
    throw new Error('Mot de passe incorrect ou données corrompues');
  }
}

/**
 * Génère un mot de passe de dérivation dérivé de l'environnement.
 * 
 * SÉCURITÉ:
 * - Combine plusieurs sources d'entropie disponibles dans le browser
 * - N'est PAS une sécurité absolue (localStorage est toujours accessible au JS)
 * - Mais augmente significativement la difficulté d'extraction brute
 * 
 * NOTE: Cette protection est une couche supplémentaire. localStorage reste
 * vulnérable aux XSS et aux accès locaux. Pour une sécurité maximale,
 * utilisez l'application native avec SecureStore.
 */
function deriveBrowserPassword(): string {
  // Combiner plusieurs sources d'entropie browser
  const components = [
    navigator.userAgent,
    navigator.language,
    screen.colorDepth?.toString(),
    screen.width + 'x' + screen.height,
    new Date().getTimezoneOffset().toString(),
    // Feature detection pour plus d'entropie
    typeof WebGLRenderingContext !== 'undefined' ? 'webgl' : 'no-webgl',
    // Entropie stockée lors de la première utilisation
    localStorage.getItem(SALT_KEY) || 'meshpay-fallback-salt',
  ];
  
  // Hash avec PBKDF2 local
  const entropy = components.join('|');
  const salt = new TextEncoder().encode('meshpay-browser-salt-v1');
  const key = pbkdf2(sha256, new TextEncoder().encode(entropy), salt, { 
    c: 10_000, 
    dkLen: 32 
  });
  
  return bytesToHex(key);
}

/**
 * Stocke le mnemonic de manière chiffrée dans localStorage.
 */
async function storeEncryptedMnemonic(mnemonic: string): Promise<void> {
  // Générer et stocker un sel unique pour cette installation si nécessaire
  if (!localStorage.getItem(SALT_KEY)) {
    const installSalt = randomBytes(32);
    localStorage.setItem(SALT_KEY, bytesToHex(installSalt));
  }
  
  const password = deriveBrowserPassword();
  const encrypted = await encryptMnemonic(mnemonic, password);
  localStorage.setItem(MNEMONIC_KEY, encrypted);
  localStorage.setItem(WALLET_INITIALIZED_KEY, 'true');
}

/**
 * Charge le mnemonic chiffré depuis localStorage.
 */
async function loadEncryptedMnemonic(): Promise<string | null> {
  const encrypted = localStorage.getItem(MNEMONIC_KEY);
  if (!encrypted) {
    return null;
  }
  
  try {
    const password = deriveBrowserPassword();
    return await decryptMnemonic(encrypted, password);
  } catch (err) {
    logger.error('[WalletSeed-Web] Failed to decrypt mnemonic:', err);
    return null;
  }
}

// ─── Migration depuis stockage non chiffré ───────────────────────────────────

/**
 * Migre un wallet non chiffré vers le format chiffré.
 */
async function migrateUnencryptedWallet(): Promise<string | null> {
  const LEGACY_KEY = 'meshcore_wallet_mnemonic';
  const legacy = localStorage.getItem(LEGACY_KEY);
  
  if (legacy && validateMnemonic(legacy)) {
    logger.warn('[WalletSeed-Web] Migration: unencrypted mnemonic detected, encrypting...');
    try {
      await storeEncryptedMnemonic(legacy);
      // Supprimer l'ancienne entrée après vérification
      const verify = await loadEncryptedMnemonic();
      if (verify === legacy) {
        localStorage.removeItem(LEGACY_KEY);
        logger.info('[WalletSeed-Web] Migration successful');
        return legacy;
      }
    } catch (err) {
      logger.error('[WalletSeed-Web] Migration failed:', err);
    }
  }
  return null;
}

export interface WalletSeedState {
  mnemonic: string | null;
  walletInfo: DerivedWalletInfo | null;
  receiveAddresses: string[];
  isInitialized: boolean;
  isLoading: boolean;
  isGenerating: boolean;
  isImporting: boolean;
  generateError: Error | null;
  importError: Error | null;
  generateNewWallet: (strength?: 12 | 24) => void;
  importWallet: (mnemonic: string) => void;
  deleteWallet: () => void;
  getFormattedAddress: () => string;
}

export const [WalletSeedContext, useWalletSeed] = createContextHook(() => {
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [walletInfo, setWalletInfo] = useState<DerivedWalletInfo | null>(null);
  const [receiveAddresses, setReceiveAddresses] = useState<string[]>([]);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);

  const loadQuery = useQuery({
    queryKey: ['wallet-seed-load'],
    queryFn: async () => {
      logger.info('[WalletSeed-Web] Loading stored mnemonic...');
      try {
        // 1. Essayer de charger le format chiffré
        let stored = await loadEncryptedMnemonic();
        
        // 2. Si non trouvé, tenter la migration depuis format non chiffré
        if (!stored) {
          stored = await migrateUnencryptedWallet();
        }
        
        if (stored && validateMnemonic(stored)) {
          logger.secure('info', '[WalletSeed-Web] Valid mnemonic loaded', stored);
          return stored;
        }
        logger.info('[WalletSeed-Web] No stored mnemonic found');
        return null;
      } catch (err) {
        logger.error('[WalletSeed-Web] Error loading mnemonic:', err);
        return null;
      }
    },
    staleTime: Infinity,
  });

  useEffect(() => {
    if (loadQuery.data) {
      setMnemonic(loadQuery.data);
      const info = deriveWalletInfo(loadQuery.data);
      setWalletInfo(info);
      setReceiveAddresses(deriveReceiveAddresses(loadQuery.data, 5));
      setIsInitialized(true);
    } else if (loadQuery.isFetched) {
      setIsInitialized(false);
    }
  }, [loadQuery.data, loadQuery.isFetched]);

  const generateMutation = useMutation({
    mutationFn: async (strength: 12 | 24) => {
      logger.info('[WalletSeed-Web] Generating new wallet...');
      const newMnemonic = generateMnemonic(strength);
      await storeEncryptedMnemonic(newMnemonic);
      logger.info('[WalletSeed-Web] Saved encrypted to localStorage');
      return newMnemonic;
    },
    onSuccess: (newMnemonic) => {
      setMnemonic(newMnemonic);
      const info = deriveWalletInfo(newMnemonic);
      setWalletInfo(info);
      setReceiveAddresses(deriveReceiveAddresses(newMnemonic, 5));
      setIsInitialized(true);
    },
    onError: (err: any) => {
      logger.error('[WalletSeed-Web] Generation error:', err);
    },
  });

  const importMutation = useMutation({
    mutationFn: async (importedMnemonic: string) => {
      logger.info('[WalletSeed-Web] Importing wallet...');
      const trimmed = importedMnemonic.trim().toLowerCase();
      if (!validateMnemonic(trimmed)) {
        throw new Error('Invalid mnemonic phrase');
      }
      await storeEncryptedMnemonic(trimmed);
      logger.info('[WalletSeed-Web] Imported wallet saved encrypted');
      return trimmed;
    },
    onSuccess: (importedMnemonic) => {
      setMnemonic(importedMnemonic);
      const info = deriveWalletInfo(importedMnemonic);
      setWalletInfo(info);
      setReceiveAddresses(deriveReceiveAddresses(importedMnemonic, 5));
      setIsInitialized(true);
    },
    onError: (err) => {
      logger.error('[WalletSeed-Web] Import error:', err);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      logger.info('[WalletSeed-Web] Deleting wallet...');
      localStorage.removeItem(MNEMONIC_KEY);
      localStorage.removeItem(WALLET_INITIALIZED_KEY);
      localStorage.removeItem(SALT_KEY);
      logger.info('[WalletSeed-Web] Wallet deleted');
    },
    onSuccess: () => {
      setMnemonic(null);
      setWalletInfo(null);
      setReceiveAddresses([]);
      setIsInitialized(false);
    },
  });

  const generateNewWallet = useCallback((strength: 12 | 24 = 12) => {
    generateMutation.mutate(strength);
  }, [generateMutation]);

  const importWallet = useCallback((importedMnemonic: string) => {
    importMutation.mutate(importedMnemonic);
  }, [importMutation]);

  const deleteWallet = useCallback(() => {
    deleteMutation.mutate();
  }, [deleteMutation]);

  const getFormattedAddress = useCallback(() => {
    if (walletInfo?.firstReceiveAddress) {
      return shortenAddress(walletInfo.firstReceiveAddress);
    }
    return 'No wallet';
  }, [walletInfo]);

  return {
    mnemonic,
    walletInfo,
    receiveAddresses,
    isInitialized,
    isLoading: loadQuery.isLoading,
    isGenerating: generateMutation.isPending,
    isImporting: importMutation.isPending,
    generateError: generateMutation.error,
    importError: importMutation.error,
    generateNewWallet,
    importWallet,
    deleteWallet,
    getFormattedAddress,
  };
});
