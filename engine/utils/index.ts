/**
 * Utils - Utilitaires pour l'engine Hermès
 */

export { EventBuilder, eb } from './EventBuilder';
export {
  CryptoWrapper,
  NobleCryptoWrapper,
  cryptoWrapper,
  getCryptoWrapper,
  randomBytes,
  timingSafeEqual,
  isValidKey,
} from './CryptoWrapper';
export {
  // Validateur
  EventValidator,
  // Schémas Zod
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
  // Types dérivés
  type ValidHermesEvent,
  type ValidMessageEvent,
  type ValidConnectionEvent,
  type ValidWalletEvent,
  type ValidBridgeEvent,
  type ValidSystemEvent,
  type ValidationResult,
} from './EventValidator';
