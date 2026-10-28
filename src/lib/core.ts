/**
 * The Rust core (`core/`, `core-wasm/`), compiled to WebAssembly and shared with the desktop app. It is instantiated
 * synchronously from bytes inlined in the bundle, so it works the same in the service worker, the offscreen document,
 * the extension pages and the unit tests, with nothing fetched. Build: `scripts/build-core.mjs`.
 */
import * as core from '@/wasm/gen/core.js';
import { CORE_WASM_BASE64 } from '@/wasm/gen/bytes';

function bytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

core.initSync({ module: bytes(CORE_WASM_BASE64) });

export { core };
