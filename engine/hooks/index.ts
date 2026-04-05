/**
 * Hermès Engine Hooks - Export centralisé
 * 
 * Hooks React pour intégrer Hermès Engine dans l'UI de MeshPay.
 * Ces hooks remplacent les providers existants par une API plus simple
 * et type-safe.
 * 
 * @example
 * ```tsx
 * import { useHermes, useMessages, useConnection } from '@/engine/hooks';
 * 
 * function ChatScreen() {
 *   const { sendDM } = useHermes();
 *   const { conversations, sendMessage } = useMessages();
 *   const { nostrConnected, loRaConnected } = useConnection();
 *   
 *   // ...
 * }
 * ```
 */

// ─── Hooks principaux ─────────────────────────────────────────────────────────

export { useHermes, type UseHermesReturn } from './useHermes';
export { useMessages, type UseMessagesReturn } from './useMessages';
export { useConnection, type UseConnectionReturn, type ConnectionStatus, type TransportState } from './useConnection';
export { useWalletHermes, type UseWalletHermesReturn } from './useWalletHermes';
export { useBridge, type UseBridgeReturn, type BridgeStats } from './useBridge';
export { useUnifiedIdentity, type UseUnifiedIdentityReturn, type UseUnifiedIdentityState, type UseUnifiedIdentityActions } from './useUnifiedIdentity';
export { useNostrHermes, type UseNostrHermesReturn } from './useNostrHermes';
export { useGateway, type UseGatewayReturn } from './useGateway';

// ─── Re-exports utiles depuis les modules engine ───────────────────────────────

export { hermes, HermesEngine, ProtocolAdapter } from '../HermesEngine';
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
} from '../types';
export { EventBuilder, eb } from '../utils/EventBuilder';

// ─── Re-exports adapters ───────────────────────────────────────────────────────

export { 
  NostrAdapter, 
  type NostrAdapterConfig, 
  DEFAULT_NOSTR_CONFIG 
} from '../adapters/NostrAdapter';

export { 
  LoRaAdapter, 
  type LoRaAdapterConfig, 
  DEFAULT_LORA_CONFIG 
} from '../adapters/LoRaAdapter';
