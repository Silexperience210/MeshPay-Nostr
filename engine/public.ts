/**
 * Hermès Engine - Exports Publics
 * 
 * Ce fichier centralise tous les exports pour éviter les problèmes
 * de résolution de chemins avec Metro bundler.
 */

// Types (from ./types)
export enum EventType {
  DM_RECEIVED = 'dm:received',
  DM_SENT = 'dm:sent',
  CHANNEL_MSG_RECEIVED = 'channel:msg_received',
  CHANNEL_MSG_SENT = 'channel:msg_sent',
  TRANSPORT_CONNECTED = 'transport:connected',
  TRANSPORT_DISCONNECTED = 'transport:disconnected',
  TRANSPORT_ERROR = 'transport:error',
  WALLET_INITIALIZED = 'wallet:initialized',
  WALLET_DELETED = 'wallet:deleted',
  BRIDGE_LORA_TO_NOSTR = 'bridge:lora_to_nostr',
  BRIDGE_NOSTR_TO_LORA = 'bridge:nostr_to_lora',
  SYSTEM_ERROR = 'system:error',
  SYSTEM_READY = 'system:ready',
}

export enum Transport {
  NOSTR = 'nostr',
  LORA = 'lora',
  USB = 'usb',
  INTERNAL = 'internal',
}

export enum MessageDirection {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
}

export interface HermesEvent {
  id: string;
  type: EventType;
  transport: Transport;
  timestamp: number;
  from: string;
  to: string;
  payload: unknown;
  meta: {
    rttMs?: number;
    hops?: number;
    protocolVersion?: string;
    originalId?: string;
  };
}

// Ré-export depuis HermesEngine
export { HermesEngine, hermes } from './HermesEngine';
export type { ProtocolAdapter } from './HermesEngine';

// Hooks (versions simplifiées)
export { useHermes } from './hooks/useHermes';
export { useUnifiedIdentity } from './hooks/useUnifiedIdentity';

// Identity
export { UnifiedIdentityManager, getIdentityManager } from './identity/UnifiedIdentityManager';
