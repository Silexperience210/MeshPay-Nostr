/**
 * Hermes Engine - Exports Publics
 *
 * Ce fichier centralise tous les exports pour eviter les problemes
 * de resolution de chemins avec Metro bundler.
 */

// Types (re-exports depuis types.ts)
export { EventType, Transport, MessageDirection } from './types';
export type { HermesEvent } from './types';

// Ré-export depuis HermesEngine
export { HermesEngine, hermes } from './HermesEngine';
export type { ProtocolAdapter } from './HermesEngine';

// Hooks (versions simplifiées)
export { useHermes } from './hooks/useHermes';
export { useUnifiedIdentity } from './hooks/useUnifiedIdentity';
