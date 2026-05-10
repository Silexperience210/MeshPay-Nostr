/**
 * Hermès Engine - Architecture event-sourced pour MeshPay
 * 
 * Export minimal qui fonctionne avec Metro bundler.
 * Les modules avancés doivent être importés directement depuis leurs chemins.
 */

// Types
export * from './types';

// Engine core
export { HermesEngine, hermes, ProtocolAdapter } from './HermesEngine';

// Hooks
export { useHermes } from './hooks/useHermes';
export { useUnifiedIdentity } from './hooks/useUnifiedIdentity';
export { useNostrHermes } from './hooks/useNostrHermes';
export { useMessages } from './hooks/useMessages';
export { useGateway } from './hooks/useGateway';

// Identity
export { 
  UnifiedIdentityManager, 
  getIdentityManager,
  resetIdentityManager 
} from './identity/UnifiedIdentityManager';

// Utils
export { EventBuilder, eb } from './utils/EventBuilder';

// NOTE: Les modules suivants doivent être importés directement:
// - import { useNostrHermes } from '@/engine/hooks/useNostrHermes';
// - import { useMessages } from '@/engine/hooks/useMessages';
// - import { messageService } from '@/engine/services/MessageService';
// - import { gatewayManager } from '@/engine/gateway/GatewayManager';
// - import { eventStore } from '@/engine/core/EventStore';
