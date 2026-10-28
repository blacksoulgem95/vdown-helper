// The extension's ID is pinned by the public `key` in manifest.json (unpacked installs and the store build share it), so the
// desktop app's native-messaging host can name it in `allowed_origins`. The private key is never in the repository.
import { createHash } from 'node:crypto';

export const EXTENSION_ID = 'gaadncjaphdelallbigeiejgolhgoipa';

/** Chrome's ID for a public key (base64 DER SubjectPublicKeyInfo): sha256, first 32 hex digits mapped to a-p. */
export function idFromKey(key) {
  return createHash('sha256')
    .update(Buffer.from(key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}
