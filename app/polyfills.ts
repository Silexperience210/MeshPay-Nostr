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

if (typeof global.crypto === 'undefined') {
  global.crypto = {
    getRandomValues: getRandomValuesPolyfill,
  } as Crypto;
} else if (typeof global.crypto.getRandomValues !== 'function') {
  (global.crypto as Crypto).getRandomValues = getRandomValuesPolyfill;
}

// URL polyfill
if (typeof global.URL === 'undefined') {
  global.URL = require('whatwg-url').URL;
}

export {};
