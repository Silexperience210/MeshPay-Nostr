/**
 * Hermès Engine - Architecture event-sourced pour MeshPay
 * 
 * Point d'entrée principal qui exporte tous les modules de l'engine.
 */

// ─── Types fondamentaux ─────────────────────────────────────────────────────
export * from './types';

// ─── Core (persistance, bus d'événements) ────────────────────────────────────
export * from './core';

// ─── Utils (builders, validateurs) ───────────────────────────────────────────
export * from './utils';

// ─── Adapters (transports) ───────────────────────────────────────────────────
export * from './adapters';

// ─── Hooks React ─────────────────────────────────────────────────────────────
export * from './hooks';

// ─── HermesEngine (singleton principal) ──────────────────────────────────────
export { HermesEngine, hermes, ProtocolAdapter } from './HermesEngine';

// ─── Identity (gestion d'identité unifiée) ───────────────────────────────────
export * from './identity';
