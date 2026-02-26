/**
 * Web polyfills - Buffer is needed by bitcoinjs-lib on web
 */

import { Buffer } from 'buffer';

if (typeof window !== 'undefined') {
  (window as any).Buffer = Buffer;
  (globalThis as any).Buffer = Buffer;
}

if (typeof global !== 'undefined' && typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

if (typeof globalThis !== 'undefined' && typeof globalThis.Buffer === 'undefined') {
  (globalThis as any).Buffer = Buffer;
}

if (typeof global !== 'undefined' && typeof global.process === 'undefined') {
  global.process = require('process');
}

export {};
