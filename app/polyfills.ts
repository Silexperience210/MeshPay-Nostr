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
try {
  if (typeof global.TextEncoder === 'undefined' || typeof global.TextDecoder === 'undefined') {
    require('@stardazed/streams-text-encoding');
    console.log('[Polyfills] TextEncoder/TextDecoder initialized');
  }
} catch (e) {
  console.warn('@stardazed/streams-text-encoding polyfill failed', e);
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
