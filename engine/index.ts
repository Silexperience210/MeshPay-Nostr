/**
 * Hermès Engine - Architecture event-sourced pour MeshPay
 * 
 * Point d'entrée principal qui exporte tous les modules de l'engine.
 */

// ─── Types fondamentaux ─────────────────────────────────────────────────────
export * from './types';

// ─── Core (persistance, bus d'événements) ────────────────────────────────────
export { EventStore, SQLiteEventStore, eventStore } from './core/EventStore';

// ─── Utils (builders, validateurs) ───────────────────────────────────────────
export { EventBuilder, eb } from './utils/EventBuilder';
export {
  EventValidator,
  HermesEventSchema,
  EventMetaSchema,
  MessageEventSchema,
  MessagePayloadSchema,
  ConnectionEventSchema,
  ConnectionPayloadSchema,
  WalletEventSchema,
  WalletPayloadSchema,
  BridgeEventSchema,
  BridgePayloadSchema,
  SystemEventSchema,
  type ValidHermesEvent,
  type ValidMessageEvent,
  type ValidConnectionEvent,
  type ValidWalletEvent,
  type ValidBridgeEvent,
  type ValidSystemEvent,
  type ValidationResult,
} from './utils/EventValidator';
export {
  CryptoWrapper,
  NobleCryptoWrapper,
  cryptoWrapper,
  getCryptoWrapper,
  randomBytes,
  timingSafeEqual,
  isValidKey,
} from './utils/CryptoWrapper';

// ─── Adapters (transports) ───────────────────────────────────────────────────
export { NostrAdapter, type NostrAdapterConfig, DEFAULT_NOSTR_CONFIG } from './adapters/NostrAdapter';
export { LoRaAdapter, type LoRaAdapterConfig, DEFAULT_LORA_CONFIG } from './adapters/LoRaAdapter';

// ─── Hooks React ─────────────────────────────────────────────────────────────
export { useHermes, type UseHermesReturn } from './hooks/useHermes';
export { useMessages, type UseMessagesReturn } from './hooks/useMessages';
export { useConnection, type UseConnectionReturn, type ConnectionStatus, type TransportState } from './hooks/useConnection';
export { useWalletHermes, type UseWalletHermesReturn } from './hooks/useWalletHermes';
export { useBridge, type UseBridgeReturn, type BridgeStats } from './hooks/useBridge';
export { useUnifiedIdentity, type UseUnifiedIdentityReturn, type UseUnifiedIdentityState, type UseUnifiedIdentityActions } from './hooks/useUnifiedIdentity';
export { useNostrHermes, type UseNostrHermesReturn } from './hooks/useNostrHermes';
export { useGateway, type UseGatewayReturn } from './hooks/useGateway';

// ─── HermesEngine (singleton principal) ──────────────────────────────────────
export { HermesEngine, hermes, ProtocolAdapter } from './HermesEngine';

// ─── Identity (gestion d'identité unifiée) ───────────────────────────────────
export { UnifiedIdentityManager, getIdentityManager, resetIdentityManager } from './identity/UnifiedIdentityManager';
export { deriveUnifiedIdentity, DERIVATION_PATHS } from './identity/Derivation';
export type { BitcoinIdentity, NostrIdentity, MeshCoreIdentity, UnifiedIdentity } from './identity/Derivation';

// ─── Services (couche métier) ────────────────────────────────────────────────
export { MessageService, MessageServiceImpl, messageService } from './services/MessageService';
export type { DirectMessage, ChannelMessage } from './services/MessageService';

// ─── Gateway (bridge LoRa ↔ Nostr) ───────────────────────────────────────────
export { GatewayManager, GatewayManagerImpl, gatewayManager } from './gateway/GatewayManager';
export type { GatewayStatus } from './gateway/GatewayManager';

// ─── Re-exports types ────────────────────────────────────────────────────────
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

// ─── EventBuilder fluent API ─────────────────────────────────────────────────
export { EventBuilder, eb } from './utils/EventBuilder';
