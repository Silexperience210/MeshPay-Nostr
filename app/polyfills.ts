/**
 * Polyfills pour React Native
 * Ces modules Node.js n'existent pas dans RN mais sont utilisés par certaines libs
 */

// Buffer
import { Buffer } from 'buffer';
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

// process
try {
  if (typeof global.process === 'undefined') {
    global.process = require('process');
  }
} catch (e) {
  console.warn('process polyfill failed', e);
}

// crypto.getRandomValues polyfill (required by bip39 / wallet seed generation)
let ExpoCrypto: typeof import('expo-crypto') | null = null;
try {
  ExpoCrypto = require('expo-crypto');
} catch (e) {
  console.warn('expo-crypto polyfill failed', e);
}

const getRandomValuesPolyfill = <T extends ArrayBufferView>(array: T): T => {
  if (!ExpoCrypto) {
    throw new Error('expo-crypto is not available - crypto polyfill failed');
  }
  const uint8Array = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const randomBytes: Uint8Array = ExpoCrypto.getRandomBytes(uint8Array.length);
  uint8Array.set(randomBytes);
  return array;
};

// Initialiser crypto sur global et globalThis (utilisé par @noble/hashes)
if (typeof global.crypto === 'undefined') {
  global.crypto = {
    getRandomValues: getRandomValuesPolyfill,
  } as Crypto;
  console.log('[Polyfills] global.crypto initialized');
} else if (typeof global.crypto.getRandomValues !== 'function') {
  (global.crypto as Crypto).getRandomValues = getRandomValuesPolyfill;
  console.log('[Polyfills] global.crypto.getRandomValues patched');
}

// @noble/hashes utilise globalThis.crypto
if (typeof globalThis === 'object') {
  if (typeof globalThis.crypto === 'undefined') {
    (globalThis as any).crypto = global.crypto;
    console.log('[Polyfills] globalThis.crypto initialized');
  } else if (typeof globalThis.crypto.getRandomValues !== 'function') {
    globalThis.crypto.getRandomValues = getRandomValuesPolyfill;
    console.log('[Polyfills] globalThis.crypto.getRandomValues patched');
  }
}

// TextEncoder / TextDecoder polyfill (required by ble-gateway, nostr-tools, etc.)
// NOTE 1: @stardazed/streams-text-encoding provides TextEncoderStream/TextDecoderStream,
//   NOT TextEncoder/TextDecoder. Use fast-text-encoding for the base classes.
// NOTE 2: On Hermes (RN's JS engine), `fast-text-encoding` attaches to `globalThis`
//   but `global.TextEncoder` may still be undefined depending on the bundle. We
//   force-mirror onto both `global` AND `globalThis` so bare `new TextEncoder()`
//   (which looks up the identifier in the global scope) always resolves.
try {
  if (typeof (globalThis as any).TextEncoder === 'undefined' || typeof (globalThis as any).TextDecoder === 'undefined') {
    require('fast-text-encoding');
    console.log('[Polyfills] TextEncoder/TextDecoder initialized via fast-text-encoding');
  }
  // Mirror onto `global` in case fast-text-encoding only patched `globalThis`
  if (typeof (global as any).TextEncoder === 'undefined' && typeof (globalThis as any).TextEncoder !== 'undefined') {
    (global as any).TextEncoder = (globalThis as any).TextEncoder;
    console.log('[Polyfills] TextEncoder mirrored from globalThis to global');
  }
  if (typeof (global as any).TextDecoder === 'undefined' && typeof (globalThis as any).TextDecoder !== 'undefined') {
    (global as any).TextDecoder = (globalThis as any).TextDecoder;
    console.log('[Polyfills] TextDecoder mirrored from globalThis to global');
  }
  // Sanity check — log if still missing so the dev sees it in Logcat
  if (typeof (global as any).TextEncoder === 'undefined') {
    console.error('[Polyfills] CRITICAL: TextEncoder still undefined on global after polyfill attempts');
  }
} catch (e) {
  console.warn('fast-text-encoding polyfill failed:', e);
}

// URL polyfill
try {
  if (typeof global.URL === 'undefined') {
    global.URL = require('whatwg-url').URL;
  }
} catch (e) {
  console.warn('whatwg-url polyfill failed', e);
}

export {};
