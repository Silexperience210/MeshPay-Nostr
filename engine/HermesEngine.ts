/**
 * HermesEngine - Moteur central de l'architecture event-sourced
 * 
 * Responsabilités:
 * 1. Router les événements entre adapters et handlers
 * 2. Gérer la déduplication globale
 * 3. Persister les événements critiques
 * 4. Fournir une API unifiée pour tous les transports
 */

import { 
  EventType, 
  Transport, 
  HermesEvent, 
  EventHandler, 
  EventFilter, 
  Subscription,
  HermesConfig,
  DEFAULT_HERMES_CONFIG,
  MessageDirection,
} from './types';

// ─── Génération d'ID ─────────────────────────────────────────────────────────
let idCounter = 0;
const generateId = (): string => {
  return `${Date.now().toString(36)}-${(++idCounter).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
};

// ─── Déduplication ───────────────────────────────────────────────────────────
class DeduplicationWindow {
  private seen = new Map<string, number>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  has(id: string): boolean {
    this.cleanup();
    return this.seen.has(id);
  }

  add(id: string): void {
    this.cleanup();
    if (this.seen.size >= this.maxSize) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.seen.delete(oldest[0]);
    }
    this.seen.set(id, Date.now());
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }

  get size(): number { return this.seen.size; }
}

// ─── Interface des Adapters ──────────────────────────────────────────────────
export interface ProtocolAdapter {
  readonly name: Transport;
  readonly isConnected: boolean;
  
  /** Démarrer l'adapter */
  start(): Promise<void>;
  /** Arrêter l'adapter */
  stop(): Promise<void>;
  /** Envoyer un message via ce transport */
  send(event: HermesEvent): Promise<void>;
  /** S'abonner aux messages entrants de cet adapter */
  onMessage(handler: (event: HermesEvent) => void): () => void;
}

// ─── HermesEngine ────────────────────────────────────────────────────────────
export class HermesEngine {
  private config: HermesConfig;
  private adapters = new Map<Transport, ProtocolAdapter>();
  private subscriptions = new Map<string, Subscription>();
  private dedup: DeduplicationWindow;
  private isRunning = false;
  private eventHistory: HermesEvent[] = []; // Pour debugging
  
  // Callbacks système
  private onErrorHandlers: Array<(error: Error, context?: string) => void> = [];

  constructor(config: Partial<HermesConfig> = {}) {
    this.config = { ...DEFAULT_HERMES_CONFIG, ...config };
    this.dedup = new DeduplicationWindow(this.config.dedupSize, this.config.dedupTtlMs);
  }

  // ─── Gestion des Adapters ─────────────────────────────────────────────────

  registerAdapter(adapter: ProtocolAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter ${adapter.name} déjà enregistré`);
    }
    
    this.adapters.set(adapter.name, adapter);
    
    // Connecter l'adapter au bus
    adapter.onMessage((event) => {
      this.handleIncomingEvent(event, adapter.name);
    });

    this.log('Adapter enregistré:', adapter.name);
  }

  unregisterAdapter(name: Transport): void {
    const adapter = this.adapters.get(name);
    if (adapter) {
      adapter.stop().catch(console.error);
      this.adapters.delete(name);
      this.log('Adapter désenregistré:', name);
    }
  }

  getAdapter(name: Transport): ProtocolAdapter | undefined {
    return this.adapters.get(name);
  }

  // ─── Démarrage/Arrêt ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.log('Hermès Engine démarré');

    // Démarrer tous les adapters
    for (const [name, adapter] of this.adapters) {
      if (this.config.adapters[name as keyof typeof this.config.adapters]) {
        try {
          await adapter.start();
          this.log(`Adapter ${name} démarré`);
        } catch (err) {
          this.error(`Échec démarrage adapter ${name}:`, err);
        }
      }
    }

    // Émettre événement système
    this.emit({
      id: generateId(),
      type: EventType.SYSTEM_READY,
      transport: Transport.INTERNAL,
      timestamp: Date.now(),
      from: 'hermes',
      to: '*',
      payload: { adapters: Array.from(this.adapters.keys()) },
      meta: {},
    });
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    
    for (const adapter of this.adapters.values()) {
      await adapter.stop().catch(console.error);
    }
    
    this.subscriptions.clear();
    this.log('Hermès Engine arrêté');
  }

  // ─── Émission d'événements ────────────────────────────────────────────────

  /**
   * Émettre un événement dans le bus
   * @param event L'événement à émettre
   * @param targetTransport Transport spécifique (optionnel, sinon tous)
   */
  async emit(event: HermesEvent, targetTransport?: Transport): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Hermès Engine non démarré');
    }

    // Déduplication
    if (this.dedup.has(event.id)) {
      this.log('Événement dupliqué ignoré:', event.id);
      return;
    }
    this.dedup.add(event.id);

    // Historique pour debugging
    if (this.config.debug) {
      this.eventHistory.push(event);
      if (this.eventHistory.length > 100) {
        this.eventHistory.shift();
      }
    }

    // Router vers le transport cible si spécifié
    if (targetTransport) {
      const adapter = this.adapters.get(targetTransport);
      if (adapter?.isConnected) {
        try {
          await adapter.send(event);
          this.log('Événement envoyé vers', targetTransport, ':', event.type);
        } catch (err) {
          this.error(`Échec envoi vers ${targetTransport}:`, err);
          throw err;
        }
      } else {
        throw new Error(`Transport ${targetTransport} non disponible`);
      }
    }

    // Dispatcher aux handlers locaux
    this.dispatchToHandlers(event);
  }

  /**
   * Créer et émettre un événement simplifié
   */
  async createEvent(
    type: EventType,
    payload: unknown,
    options: {
      from?: string;
      to?: string;
      transport?: Transport;
      meta?: HermesEvent['meta'];
    } = {}
  ): Promise<void> {
    const event: HermesEvent = {
      id: generateId(),
      type,
      transport: options.transport || Transport.INTERNAL,
      timestamp: Date.now(),
      from: options.from || 'local',
      to: options.to || '*',
      payload,
      meta: options.meta || {},
    };

    await this.emit(event);
  }

  // ─── Souscription ─────────────────────────────────────────────────────────

  subscribe(filter: EventFilter, handler: EventHandler, maxCalls?: number): () => void {
    const sub: Subscription = {
      id: generateId(),
      filter,
      handler,
      maxCalls,
      callCount: 0,
    };

    this.subscriptions.set(sub.id, sub);
    
    return () => {
      this.subscriptions.delete(sub.id);
    };
  }

  /**
   * Souscription simplifiée par type d'événement
   */
  on<T extends HermesEvent>(
    type: EventType, 
    handler: EventHandler<T>,
    options: { from?: string; to?: string } = {}
  ): () => void {
    return this.subscribe(
      {
        types: [type],
        from: options.from ? [options.from] : undefined,
        to: options.to ? [options.to] : undefined,
      },
      handler as EventHandler
    );
  }

  /**
   * Souscription one-shot
   */
  once<T extends HermesEvent>(
    type: EventType,
    handler: EventHandler<T>
  ): () => void {
    return this.subscribe(
      { types: [type] },
      handler as EventHandler,
      1
    );
  }

  // ─── Gestion interne ──────────────────────────────────────────────────────

  private handleIncomingEvent(event: HermesEvent, sourceTransport: Transport): void {
    // Mettre à jour le transport source
    event.transport = sourceTransport;
    
    this.log('Événement reçu de', sourceTransport, ':', event.type);
    
    // Déduplication
    if (this.dedup.has(event.id)) {
      this.log('Duplicat ignoré:', event.id);
      return;
    }
    this.dedup.add(event.id);

    // Dispatcher
    this.dispatchToHandlers(event);
  }

  private dispatchToHandlers(event: HermesEvent): void {
    for (const sub of this.subscriptions.values()) {
      if (this.matchesFilter(event, sub.filter)) {
        // Incrémenter compteur
        sub.callCount++;
        
        // Appeler handler
        try {
          const result = sub.handler(event);
          if (result instanceof Promise) {
            result.catch(err => this.error('Erreur handler async:', err));
          }
        } catch (err) {
          this.error('Erreur handler:', err);
        }

        // Auto-unsubscribe si maxCalls atteint
        if (sub.maxCalls && sub.callCount >= sub.maxCalls) {
          this.subscriptions.delete(sub.id);
        }
      }
    }
  }

  private matchesFilter(event: HermesEvent, filter: EventFilter): boolean {
    if (filter.types && !filter.types.includes(event.type)) return false;
    if (filter.transports && !filter.transports.includes(event.transport)) return false;
    if (filter.from && !filter.from.includes(event.from)) return false;
    if (filter.to && !filter.to.includes(event.to) && event.to !== '*') return false;
    if (filter.custom && !filter.custom(event)) return false;
    return true;
  }

  // ─── Utilitaires ──────────────────────────────────────────────────────────

  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log('[Hermès]', ...args);
    }
  }

  private error(...args: unknown[]): void {
    console.error('[Hermès]', ...args);
    this.onErrorHandlers.forEach(h => {
      try {
        h(args[0] as Error, String(args[1]));
      } catch {}
    });
  }

  onError(handler: (error: Error, context?: string) => void): () => void {
    this.onErrorHandlers.push(handler);
    return () => {
      const idx = this.onErrorHandlers.indexOf(handler);
      if (idx > -1) this.onErrorHandlers.splice(idx, 1);
    };
  }

  get stats(): {
    adapters: number;
    subscriptions: number;
    dedupSize: number;
    isRunning: boolean;
  } {
    return {
      adapters: this.adapters.size,
      subscriptions: this.subscriptions.size,
      dedupSize: this.dedup.size,
      isRunning: this.isRunning,
    };
  }

  getHistory(limit = 50): HermesEvent[] {
    return this.eventHistory.slice(-limit);
  }
}

// ─── Singleton global ───────────────────────────────────────────────────────
export const hermes = new HermesEngine();
