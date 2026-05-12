/**
 * Text codec utility — UTF-8 string <-> Uint8Array
 *
 * Uses native `TextEncoder`/`TextDecoder` when available (polyfilled via
 * `app/polyfills.ts`), with a `Buffer` fallback that is guaranteed to be
 * present on React Native (`buffer` is also polyfilled in `polyfills.ts`).
 *
 * Why: on Hermes (RN's JS engine), `new TextEncoder()` can throw
 * "undefined is not a function" in release builds even when the polyfill is
 * loaded, because the identifier resolution differs between `global` and
 * `globalThis`. Going through `Buffer` avoids the issue entirely.
 */

import { Buffer } from 'buffer';

/** Encode a string into UTF-8 bytes. Safe on Hermes. */
export function utf8Encode(s: string): Uint8Array {
  try {
    // Fast path: native TextEncoder (polyfilled on Hermes via fast-text-encoding)
    if (typeof (globalThis as any).TextEncoder === 'function') {
      return new (globalThis as any).TextEncoder().encode(s);
    }
  } catch {
    // fall through to Buffer
  }
  // Fallback: Buffer (always available, polyfilled in app/polyfills.ts)
  return new Uint8Array(Buffer.from(s, 'utf-8'));
}

/** Decode UTF-8 bytes into a string. Safe on Hermes. */
export function utf8Decode(b: Uint8Array): string {
  try {
    if (typeof (globalThis as any).TextDecoder === 'function') {
      return new (globalThis as any).TextDecoder('utf-8').decode(b);
    }
  } catch {
    // fall through
  }
  return Buffer.from(b).toString('utf-8');
}
