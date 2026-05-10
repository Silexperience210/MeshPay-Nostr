/**
 * Module identity - Gestion d'identité unifiée
 * 
 * Exporte tous les types et classes pour la dérivation et la gestion
 * des identités Bitcoin, Nostr et MeshCore depuis une seed unique.
 */

// ─── Dérivation ───────────────────────────────────────────────────────────────
export {
  // Chemins de dérivation
  DERIVATION_PATHS,
  // Fonction principale
  deriveUnifiedIdentity,
  // Utilitaires
  hexToBytes,
  getPublicKey,
  // Types
  type BitcoinIdentity,
  type NostrIdentity,
  type MeshCoreIdentity,
  type UnifiedIdentity,
} from './Derivation';

// ─── Gestionnaire ─────────────────────────────────────────────────────────────
export {
  UnifiedIdentityManager,
  getIdentityManager,
  resetIdentityManager,
  // Types
  type StoredIdentity,
  type EncryptedBackup,
  type CreateIdentityOptions,
  type CreateIdentityResult,
  type PublicIdentity,
  // Erreurs
  IdentityError,
  DecryptionError,
  IdentityNotFoundError,
} from './UnifiedIdentityManager';
