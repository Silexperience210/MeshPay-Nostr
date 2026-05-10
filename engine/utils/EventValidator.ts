/**
 * EventValidator - Validation des événements avec Zod
 * 
 * Fournit des schémas Zod stricts pour tous les types d'événements Hermès.
 * Garantit l'intégrité des données avant persistance ou traitement.
 */

import { z } from 'zod';
import { 
  EventType, 
  Transport, 
  HermesEvent, 
  MessageEvent, 
  ConnectionEvent,
  WalletEvent,
  BridgeEvent,
} from '../types';

// ─── Enums Zod ──────────────────────────────────────────────────────────────

const EventTypeSchema = z.nativeEnum(EventType);
const TransportSchema = z.nativeEnum(Transport);

// ─── Schémas de base ────────────────────────────────────────────────────────

/** Métadonnées d'un événement */
export const EventMetaSchema = z.object({
  rttMs: z.number().positive().optional(),
  hops: z.number().int().nonnegative().optional(),
  protocolVersion: z.string().optional(),
  originalId: z.string().optional(),
}).passthrough();

/** Schéma de base pour tous les événements Hermès */
export const HermesEventSchema = z.object({
  id: z.string().min(1, 'ID requis'),
  type: EventTypeSchema,
  transport: TransportSchema,
  timestamp: z.number().int().positive('Timestamp doit être positif'),
  from: z.string().min(1, 'Expéditeur requis'),
  to: z.string().min(1, 'Destinataire requis'),
  payload: z.unknown(),
  meta: EventMetaSchema.default({}),
});

// ─── Schémas spécifiques par type ───────────────────────────────────────────

/** Payload d'un message */
export const MessagePayloadSchema = z.object({
  content: z.string().min(1, 'Contenu requis'),
  contentType: z.string().min(1, 'Type de contenu requis'),
  encryption: z.enum(['nip04', 'nip44', 'meshcore_aes']).optional(),
  channelName: z.string().optional(),
  amountSats: z.number().int().nonnegative().optional(),
});

/** Schéma pour les événements de message - utilise union de literals */
export const MessageEventSchema = z.object({
  id: z.string().min(1, 'ID requis'),
  type: z.union([
    z.literal(EventType.DM_RECEIVED),
    z.literal(EventType.DM_SENT),
    z.literal(EventType.CHANNEL_MSG_RECEIVED),
    z.literal(EventType.CHANNEL_MSG_SENT),
  ]),
  transport: TransportSchema,
  timestamp: z.number().int().positive('Timestamp doit être positif'),
  from: z.string().min(1, 'Expéditeur requis'),
  to: z.string().min(1, 'Destinataire requis'),
  payload: MessagePayloadSchema,
  meta: EventMetaSchema.default({}),
});

// ───

/** Payload d'un événement de connexion */
export const ConnectionPayloadSchema = z.object({
  transport: TransportSchema,
  endpoint: z.string().optional(),
  error: z.string().optional(),
  reconnectAttempt: z.number().int().nonnegative().optional(),
});

/** Schéma pour les événements de connexion */
export const ConnectionEventSchema = z.object({
  id: z.string().min(1, 'ID requis'),
  type: z.union([
    z.literal(EventType.TRANSPORT_CONNECTED),
    z.literal(EventType.TRANSPORT_DISCONNECTED),
    z.literal(EventType.TRANSPORT_ERROR),
  ]),
  transport: TransportSchema,
  timestamp: z.number().int().positive('Timestamp doit être positif'),
  from: z.string().min(1, 'Expéditeur requis'),
  to: z.string().min(1, 'Destinataire requis'),
  payload: ConnectionPayloadSchema,
  meta: EventMetaSchema.default({}),
});

// ───

/** Payload d'un événement wallet */
export const WalletPayloadSchema = z.object({
  nodeId: z.string().min(1, 'Node ID requis'),
  npub: z.string().optional(),
});

/** Schéma pour les événements wallet */
export const WalletEventSchema = z.object({
  id: z.string().min(1, 'ID requis'),
  type: z.union([
    z.literal(EventType.WALLET_INITIALIZED),
    z.literal(EventType.WALLET_DELETED),
  ]),
  transport: TransportSchema,
  timestamp: z.number().int().positive('Timestamp doit être positif'),
  from: z.string().min(1, 'Expéditeur requis'),
  to: z.string().min(1, 'Destinataire requis'),
  payload: WalletPayloadSchema,
  meta: EventMetaSchema.default({}),
});

// ───

/** Payload d'un événement bridge */
export const BridgePayloadSchema = z.object({
  originalTransport: TransportSchema,
  targetTransport: TransportSchema,
  rawPayload: z.string().min(1, 'Payload brut requis'),
});

/** Schéma pour les événements bridge */
export const BridgeEventSchema = z.object({
  id: z.string().min(1, 'ID requis'),
  type: z.union([
    z.literal(EventType.BRIDGE_LORA_TO_NOSTR),
    z.literal(EventType.BRIDGE_NOSTR_TO_LORA),
  ]),
  transport: TransportSchema,
  timestamp: z.number().int().positive('Timestamp doit être positif'),
  from: z.string().min(1, 'Expéditeur requis'),
  to: z.string().min(1, 'Destinataire requis'),
  payload: BridgePayloadSchema,
  meta: EventMetaSchema.default({}),
});

// ───

/** Schéma pour les événements système (payload flexible) */
export const SystemEventSchema = z.object({
  id: z.string().min(1, 'ID requis'),
  type: z.union([
    z.literal(EventType.SYSTEM_ERROR),
    z.literal(EventType.SYSTEM_READY),
  ]),
  transport: TransportSchema,
  timestamp: z.number().int().positive('Timestamp doit être positif'),
  from: z.string().min(1, 'Expéditeur requis'),
  to: z.string().min(1, 'Destinataire requis'),
  payload: z.record(z.string(), z.unknown()).default({}),
  meta: EventMetaSchema.default({}),
});

// ─── Types dérivés (infer) ──────────────────────────────────────────────────

export type ValidHermesEvent = z.infer<typeof HermesEventSchema>;
export type ValidMessageEvent = z.infer<typeof MessageEventSchema>;
export type ValidConnectionEvent = z.infer<typeof ConnectionEventSchema>;
export type ValidWalletEvent = z.infer<typeof WalletEventSchema>;
export type ValidBridgeEvent = z.infer<typeof BridgeEventSchema>;
export type ValidSystemEvent = z.infer<typeof SystemEventSchema>;

// ─── Validateur ─────────────────────────────────────────────────────────────

export type ValidationResult<T> = 
  | { success: true; data: T }
  | { success: false; error: z.ZodError };

export class EventValidator {
  /**
   * Valide un événement générique
   * @throws ZodError si la validation échoue
   */
  static validate(event: unknown): HermesEvent {
    return HermesEventSchema.parse(event);
  }

  /**
   * Valide un événement de message
   * @throws ZodError si la validation échoue
   */
  static validateMessage(event: unknown): MessageEvent {
    return MessageEventSchema.parse(event) as MessageEvent;
  }

  /**
   * Valide un événement de connexion
   * @throws ZodError si la validation échoue
   */
  static validateConnection(event: unknown): ConnectionEvent {
    return ConnectionEventSchema.parse(event) as ConnectionEvent;
  }

  /**
   * Valide un événement wallet
   * @throws ZodError si la validation échoue
   */
  static validateWallet(event: unknown): WalletEvent {
    return WalletEventSchema.parse(event) as WalletEvent;
  }

  /**
   * Valide un événement bridge
   * @throws ZodError si la validation échoue
   */
  static validateBridge(event: unknown): BridgeEvent {
    return BridgeEventSchema.parse(event) as BridgeEvent;
  }

  /**
   * Valide un événement système
   * @throws ZodError si la validation échoue
   */
  static validateSystem(event: unknown): HermesEvent {
    return SystemEventSchema.parse(event);
  }

  /**
   * Validation sécurisée (ne lance pas d'exception)
   */
  static validateSafe(event: unknown): ValidationResult<HermesEvent> {
    const result = HermesEventSchema.safeParse(event);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: result.error };
  }

  /**
   * Valide un message de manière sécurisée
   */
  static validateMessageSafe(event: unknown): ValidationResult<MessageEvent> {
    const result = MessageEventSchema.safeParse(event);
    if (result.success) {
      return { success: true, data: result.data as MessageEvent };
    }
    return { success: false, error: result.error };
  }

  /**
   * Valide une connexion de manière sécurisée
   */
  static validateConnectionSafe(event: unknown): ValidationResult<ConnectionEvent> {
    const result = ConnectionEventSchema.safeParse(event);
    if (result.success) {
      return { success: true, data: result.data as ConnectionEvent };
    }
    return { success: false, error: result.error };
  }

  /**
   * Valide un wallet de manière sécurisée
   */
  static validateWalletSafe(event: unknown): ValidationResult<WalletEvent> {
    const result = WalletEventSchema.safeParse(event);
    if (result.success) {
      return { success: true, data: result.data as WalletEvent };
    }
    return { success: false, error: result.error };
  }

  /**
   * Valide un bridge de manière sécurisée
   */
  static validateBridgeSafe(event: unknown): ValidationResult<BridgeEvent> {
    const result = BridgeEventSchema.safeParse(event);
    if (result.success) {
      return { success: true, data: result.data as BridgeEvent };
    }
    return { success: false, error: result.error };
  }

  // ─── Helpers utilitaires ───────────────────────────────────────────────────

  /**
   * Récupère la liste des erreurs de validation sous forme de strings
   */
  static getErrors(event: unknown): string[] {
    const result = HermesEventSchema.safeParse(event);
    if (result.success) return [];

    // Zod v4 compatibility: errors might be in different format
    const issues = (result.error as any).issues || (result.error as any).errors || [];
    return issues.map((e: any) => {
      const path = e.path?.length > 0 ? e.path.join('.') : 'root';
      return `${path}: ${e.message}`;
    });
  }

  /**
   * Récupère les erreurs détaillées avec le path et le message
   */
  static getDetailedErrors(event: unknown): Array<{ path: string; message: string; code: string }> {
    const result = HermesEventSchema.safeParse(event);
    if (result.success) return [];

    // Zod v4 compatibility: errors might be in different format
    const issues = (result.error as any).issues || (result.error as any).errors || [];
    return issues.map((e: any) => ({
      path: e.path?.length > 0 ? e.path.join('.') : 'root',
      message: e.message,
      code: e.code || 'unknown',
    }));
  }

  /**
   * Vérifie si un événement est valide sans retourner les données
   */
  static isValid(event: unknown): boolean {
    return HermesEventSchema.safeParse(event).success;
  }

  /**
   * Vérifie si un événement est un message valide
   */
  static isValidMessage(event: unknown): boolean {
    return MessageEventSchema.safeParse(event).success;
  }

  /**
   * Vérifie si un événement est une connexion valide
   */
  static isValidConnection(event: unknown): boolean {
    return ConnectionEventSchema.safeParse(event).success;
  }

  /**
   * Détecte le type d'événement et valide avec le schéma approprié
   */
  static validateByType(event: unknown): ValidationResult<HermesEvent> {
    // D'abord valider la structure de base pour obtenir le type
    const baseResult = HermesEventSchema.safeParse(event);
    if (!baseResult.success) {
      return { success: false, error: baseResult.error };
    }

    const { type } = baseResult.data;

    // Valider avec le schéma spécifique selon le type
    switch (type) {
      case EventType.DM_RECEIVED:
      case EventType.DM_SENT:
      case EventType.CHANNEL_MSG_RECEIVED:
      case EventType.CHANNEL_MSG_SENT:
        return this.validateMessageSafe(event);

      case EventType.TRANSPORT_CONNECTED:
      case EventType.TRANSPORT_DISCONNECTED:
      case EventType.TRANSPORT_ERROR:
        return this.validateConnectionSafe(event);

      case EventType.WALLET_INITIALIZED:
      case EventType.WALLET_DELETED:
        return this.validateWalletSafe(event);

      case EventType.BRIDGE_LORA_TO_NOSTR:
      case EventType.BRIDGE_NOSTR_TO_LORA:
        return this.validateBridgeSafe(event);

      case EventType.SYSTEM_ERROR:
      case EventType.SYSTEM_READY:
        // Pour les événements système, on utilise le schéma de base
        // car ils ont un payload flexible
        return { success: true, data: baseResult.data };

      default:
        return { success: true, data: baseResult.data };
    }
  }
}
