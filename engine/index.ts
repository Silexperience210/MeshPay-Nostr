/**
 * Hermès Engine - Architecture event-sourced pour MeshPay
 * 
 * Point d'entrée principal qui exporte tous les modules de l'engine.
 */

// ─── Types fondamentaux ─────────────────────────────────────────────────────
export {
  EventType,
  Transport,
  MessageDirection,
  type HermesEvent,
  type MessageEvent,
  type ConnectionEvent,
  type WalletEvent,
  type BridgeEvent,
  type EventHandler,
  type EventFilter,
  type Subscription,
  type HermesConfig,
  DEFAULT_HERMES_CONFIG,
} from './types';

// ─── HermesEngine (singleton principal) ──────────────────────────────────────
export { HermesEngine, hermes, ProtocolAdapter } from './HermesEngine';

// ─── Core (persistance) ─────────────────────────────────────────────────────
export {
  EventStore,
  SQLiteEventStore,
  eventStore,
} from './core/EventStore';

// ─── Utils ──────────────────────────────────────────────────────────────────
export { EventBuilder, eb } from './utils/EventBuilder';
export {
  CryptoWrapper,
  NobleCryptoWrapper,
  cryptoWrapper,
  getCryptoWrapper,
  randomBytes,
  timingSafeEqual,
  isValidKey,
} from './utils/CryptoWrapper';

// ─── Identity ───────────────────────────────────────────────────────────────
export {
  UnifiedIdentityManager,
  getIdentityManager,
  resetIdentityManager,
} from './identity/UnifiedIdentityManager';

// ─── Hooks (basiques) ───────────────────────────────────────────────────────
export { useHermes, type UseHermesReturn } from './hooks/useHermes';
export { useUnifiedIdentity, type UseUnifiedIdentityReturn } from './hooks/useUnifiedIdentity';
export { useNostrHermes, type UseNostrHermesReturn } from './hooks/useNostrHermes';
export { useGateway, type UseGatewayReturn } from './hooks/useGateway';
export { useMessages, type UseMessagesReturn } from './hooks/useMessages';

// ─── Adapters ───────────────────────────────────────────────────────────────
export { NostrAdapter, type NostrAdapterConfig } from './adapters/NostrAdapter';
export { LoRaAdapter, type LoRaAdapterConfig } from './adapters/LoRaAdapter';

// ─── Services ───────────────────────────────────────────────────────────────
export { MessageService, MessageServiceImpl, messageService } from './services/MessageService';
export type { DirectMessage, ChannelMessage } from './services/MessageService';

// ─── Gateway ────────────────────────────────────────────────────────────────
export { GatewayManager, GatewayManagerImpl, gatewayManager } from './gateway/GatewayManager';
export type { GatewayStatus } from './gateway/GatewayManager';
