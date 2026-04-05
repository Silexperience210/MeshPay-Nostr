/**
 * Types fondamentaux de l'architecture Hermès
 * Tous les événements du système sont typés et traçables
 */

// ─── Transports supportés ───────────────────────────────────────────────────
export enum Transport {
  NOSTR = 'nostr',
  LORA = 'lora',
  USB = 'usb',
  INTERNAL = 'internal', // Événements UI/system
}

// ─── Types d'événements ─────────────────────────────────────────────────────
export enum EventType {
  // Messages
  DM_RECEIVED = 'dm:received',
  DM_SENT = 'dm:sent',
  CHANNEL_MSG_RECEIVED = 'channel:msg_received',
  CHANNEL_MSG_SENT = 'channel:msg_sent',
  
  // Connexion
  TRANSPORT_CONNECTED = 'transport:connected',
  TRANSPORT_DISCONNECTED = 'transport:disconnected',
  TRANSPORT_ERROR = 'transport:error',
  
  // Wallet
  WALLET_INITIALIZED = 'wallet:initialized',
  WALLET_DELETED = 'wallet:deleted',
  
  // Bridge
  BRIDGE_LORA_TO_NOSTR = 'bridge:lora_to_nostr',
  BRIDGE_NOSTR_TO_LORA = 'bridge:nostr_to_lora',
  
  // Système
  SYSTEM_ERROR = 'system:error',
  SYSTEM_READY = 'system:ready',
}

export enum MessageDirection {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
}

// ─── Interface événement de base ────────────────────────────────────────────
export interface HermesEvent {
  /** UUID v4 unique de l'événement */
  id: string;
  /** Type de l'événement */
  type: EventType;
  /** Transport source */
  transport: Transport;
  /** Timestamp Unix ms */
  timestamp: number;
  /** ID du device/node émetteur */
  from: string;
  /** ID du destinataire (ou '*' pour broadcast) */
  to: string;
  /** Payload spécifique au type */
  payload: unknown;
  /** Métadonnées du transport */
  meta: {
    /** Latence réseau si disponible */
    rttMs?: number;
    /** Sauts/routing info */
    hops?: number;
    /** Version du protocole */
    protocolVersion?: string;
    /** ID original du transport sous-jacent (event.id Nostr, etc) */
    originalId?: string;
  };
}

// ─── Événements spécifiques ─────────────────────────────────────────────────
export interface MessageEvent extends HermesEvent {
  type: EventType.DM_RECEIVED | EventType.DM_SENT | 
        EventType.CHANNEL_MSG_RECEIVED | EventType.CHANNEL_MSG_SENT;
  payload: {
    /** Contenu du message (déchiffré) */
    content: string;
    /** Type de contenu: text, image, audio, cashu, etc */
    contentType: string;
    /** Si chiffré: méthode utilisée */
    encryption?: 'nip04' | 'nip44' | 'meshcore_aes';
    /** Pour forums: nom du channel */
    channelName?: string;
    /** Pour Cashu: montant en sats */
    amountSats?: number;
  };
}

export interface ConnectionEvent extends HermesEvent {
  type: EventType.TRANSPORT_CONNECTED | EventType.TRANSPORT_DISCONNECTED | 
        EventType.TRANSPORT_ERROR;
  payload: {
    transport: Transport;
    endpoint?: string; // URL relay, device BLE ID, etc
    error?: string;
    reconnectAttempt?: number;
  };
}

export interface WalletEvent extends HermesEvent {
  type: EventType.WALLET_INITIALIZED | EventType.WALLET_DELETED;
  payload: {
    nodeId: string;
    npub?: string;
    // Jamais le mnemonic ici!
  };
}

export interface BridgeEvent extends HermesEvent {
  type: EventType.BRIDGE_LORA_TO_NOSTR | EventType.BRIDGE_NOSTR_TO_LORA;
  payload: {
    originalTransport: Transport;
    targetTransport: Transport;
    rawPayload: string; // Payload original avant transformation
  };
}

// ─── Système de souscription ────────────────────────────────────────────────
export type EventHandler<T extends HermesEvent = HermesEvent> = (event: T) => void | Promise<void>;

export interface EventFilter {
  types?: EventType[];
  transports?: Transport[];
  from?: string[];
  to?: string[];
  /** Fonction de filtre personnalisée */
  custom?: (event: HermesEvent) => boolean;
}

export interface Subscription {
  id: string;
  filter: EventFilter;
  handler: EventHandler;
  /** Auto-unsubscribe après N appels (optionnel) */
  maxCalls?: number;
  callCount: number;
}

// ─── Configuration ──────────────────────────────────────────────────────────
export interface HermesConfig {
  /** Activer le logging détaillé */
  debug: boolean;
  /** Durée de rétention des événements en mémoire (ms) */
  memoryRetentionMs: number;
  /** Taille max de la fenêtre de déduplication */
  dedupSize: number;
  /** TTL de déduplication (ms) */
  dedupTtlMs: number;
  /** Adapters à activer */
  adapters: {
    nostr?: boolean;
    lora?: boolean;
    usb?: boolean;
  };
}

export const DEFAULT_HERMES_CONFIG: HermesConfig = {
  debug: __DEV__,
  memoryRetentionMs: 5 * 60 * 1000, // 5 minutes
  dedupSize: 1000,
  dedupTtlMs: 5 * 60 * 1000,
  adapters: {
    nostr: true,
    lora: true,
    usb: false,
  },
};
