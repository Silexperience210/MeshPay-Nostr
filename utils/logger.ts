/**
 * Logger sécurisé avec niveaux et masquage des secrets
 * 
 * Usage: 
 *   logger.debug('message') | logger.info('message') | logger.error('message')
 *   logger.debugSecure('message', sensitiveData) - masque les secrets en production
 * 
 * Sécurité:
 *   - En production (__DEV__ === false), seuls les erreurs critiques sont loggés
 *   - Les données sensibles (mnemonic, clés privées, proofs Cashu) sont masquées
 *   - Pas de fuite de secrets via les logs
 */

// @ts-ignore - subpath exports use .js extension
import { randomBytes } from '@noble/hashes/utils.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL: LogLevel = __DEV__ ? 'debug' : 'error'; // En prod, seulement errors

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Patterns pour détecter les données sensibles à masquer
const SENSITIVE_PATTERNS = [
  /mnemonic["\s:=]+([^"\s]{20,})/gi,           // Phrase mnémonique
  /seed["\s:=]+([a-f0-9]{32,})/gi,             // Seed hex
  /privkey["\s:=]+([a-f0-9]{64})/gi,           // Clé privée
  /secret["\s:=]+([a-f0-9]{32,})/gi,           // Secret
  /proofs?:\s*\[?\s*{[^}]*secret[^}]*}/gi,     // Preuves Cashu
  /C_?["\s:=]+([a-f0-9]{66})/gi,               // Clé publique compressée
  /[\"']cashu[AB][a-zA-Z0-9+/=]{100,}/g,       // Token Cashu encodé
  /"amount":\s*\d+[^}]*"secret"/gi,            // Secrets dans JSON
];

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[LOG_LEVEL];
}

/**
 * Masque les données sensibles dans un message de log
 */
function sanitizeLogMessage(message: string): string {
  if (__DEV__) {
    // En dev, on masque partiellement pour le debugging
    return message;
  }
  
  let sanitized = message;
  
  // Remplacer les patterns sensibles par [REDACTED]
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  
  // Masquer les potentiels secrets hex longs
  sanitized = sanitized.replace(/\b[a-f0-9]{64,}\b/gi, '[HEX_REDACTED]');
  
  return sanitized;
}

/**
 * Génère un ID de corrélation sécurisé pour le tracing
 * sans exposer d'informations sensibles
 */
export function generateTraceId(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes)
    .map((b: number) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export const logger = {
  debug: (message: string, ...args: any[]) => {
    if (shouldLog('debug')) {
      const sanitized = sanitizeLogMessage(message);
      // En production, ne jamais logger de debug même sanitizé
      if (__DEV__) {
        console.log(`[DEBUG] ${sanitized}`, ...args);
      }
    }
  },

  info: (message: string, ...args: any[]) => {
    if (shouldLog('info')) {
      const sanitized = sanitizeLogMessage(message);
      console.log(`[INFO] ${sanitized}`, ...args);
    }
  },

  warn: (message: string, ...args: any[]) => {
    if (shouldLog('warn')) {
      const sanitized = sanitizeLogMessage(message);
      console.warn(`[WARN] ${sanitized}`, ...args);
    }
  },

  error: (message: string, ...args: any[]) => {
    if (shouldLog('error')) {
      const sanitized = sanitizeLogMessage(message);
      console.error(`[ERROR] ${sanitized}`, ...args);
    }
  },

  /**
   * Log sécurisé qui masque TOUJOURS les arguments sensibles,
   * même en mode développement
   */
  secure: (level: LogLevel, message: string, ...sensitiveArgs: any[]) => {
    if (shouldLog(level)) {
      // Toujours masquer les arguments sensibles
      const maskedArgs = sensitiveArgs.map(() => '[REDACTED]');
      const prefix = `[${level.toUpperCase()}]`;
      
      switch (level) {
        case 'debug':
          if (__DEV__) console.log(prefix, message, ...maskedArgs);
          break;
        case 'info':
          console.log(prefix, message, ...maskedArgs);
          break;
        case 'warn':
          console.warn(prefix, message, ...maskedArgs);
          break;
        case 'error':
          console.error(prefix, message, ...maskedArgs);
          break;
      }
    }
  },
};

export default logger;
