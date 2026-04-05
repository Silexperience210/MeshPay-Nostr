/**
 * Hermès Engine - Architecture event-sourced pour MeshPay
 */

// Export minimal pour test
export { HermesEngine, hermes, ProtocolAdapter } from './HermesEngine';
export * from './types';

// Core - éviter les imports problématiques pour l'instant
// export * from './core/EventStore';

// Utils
export { EventBuilder, eb } from './utils/EventBuilder';

// Identity
export { UnifiedIdentityManager, getIdentityManager } from './identity/UnifiedIdentityManager';

// Hooks basiques uniquement
export { useHermes } from './hooks/useHermes';
export { useUnifiedIdentity } from './hooks/useUnifiedIdentity';

// Adapters
export { NostrAdapter } from './adapters/NostrAdapter';
export { LoRaAdapter } from './adapters/LoRaAdapter';
