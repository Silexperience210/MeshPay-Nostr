// Must be first - polyfill Buffer before any module loads
const { Buffer } = require('buffer');
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer;
}
if (typeof window !== 'undefined' && typeof window.Buffer === 'undefined') {
  window.Buffer = Buffer;
}

// process polyfill
if (typeof global.process === 'undefined') {
  global.process = require('process');
}
if (typeof globalThis.process === 'undefined') {
  globalThis.process = require('process');
}

// Now load expo-router entry
require('expo-router/entry');
