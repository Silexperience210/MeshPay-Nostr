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
if (typeof global.process === 'undefined') {
  global.process = require('process');
}

// crypto.getRandomValues polyfill (required by bip39 / wallet seed generation)
const ExpoCrypto = require('expo-crypto');

const getRandomValuesPolyfill = <T extends ArrayBufferView>(array: T): T => {
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

// URL polyfill
if (typeof global.URL === 'undefined') {
  global.URL = require('whatwg-url').URL;
}

export {};
