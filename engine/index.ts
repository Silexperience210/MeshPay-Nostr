/**
 * Hermès Engine - Architecture event-sourced pour MeshPay
 * 
 * Point d'entrée principal qui exporte tous les modules de l'engine.
 */

// ─── Types fondamentaux ─────────────────────────────────────────────────────
export * from './types';

// ─── Core (persistance, bus d'événements) ────────────────────────────────────
export * from './core/index';

// ─── Utils (builders, validateurs) ───────────────────────────────────────────
export * from './utils/index';

// ─── Adapters (transports) ───────────────────────────────────────────────────
export * from './adapters/index';

// ─── Hooks React ─────────────────────────────────────────────────────────────
export * from './hooks/index';

// ─── HermesEngine (singleton principal) ──────────────────────────────────────
export { HermesEngine, hermes, ProtocolAdapter } from './HermesEngine';

// ─── Identity (gestion d'identité unifiée) ───────────────────────────────────
export * from './identity/index';

// ─── Services (couche métier) ────────────────────────────────────────────────
export * from './services/index';

// ─── Gateway (bridge LoRa ↔ Nostr) ───────────────────────────────────────────
export * from './gateway/index';
