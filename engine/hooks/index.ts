/**
 * Hermès Engine Hooks - Export centralisé
 * 
 * NOTE: Certains hooks ont des dépendances complexes et doivent être
 * importés directement depuis leur fichier source.
 */

// Hooks de base (sans dépendances externes)
export { useHermes, type UseHermesReturn } from './useHermes';
export { useUnifiedIdentity, type UseUnifiedIdentityReturn } from './useUnifiedIdentity';

// Hooks avancés - importez directement:
// import { useNostrHermes } from '@/engine/hooks/useNostrHermes';
// import { useMessages } from '@/engine/hooks/useMessages';
// import { useGateway } from '@/engine/hooks/useGateway';
// import { useConnection } from '@/engine/hooks/useConnection';
// import { useBridge } from '@/engine/hooks/useBridge';
// import { useWalletHermes } from '@/engine/hooks/useWalletHermes';
