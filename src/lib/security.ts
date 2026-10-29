/**
 * URL validation, redaction, and filename sanitisation. The decisions are implemented in Rust (`core/src/security.rs`)
 * and shared with the desktop app; what needs `chrome.*` or the `URL` object stays here.
 */
import { core } from './core';

/** Parse a URL, returning undefined instead of throwing. */
export function parseUrl(input: string, base?: string): URL | undefined {
  try {
    return base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return undefined;
  }
}

/** The longest address the extension will fetch. Real signed URLs stay well below this; a manifest cannot make it grow. */
export const MAX_URL_LENGTH = 8192;

/** True for http(s) URLs only. Everything else (javascript:, data:, file:, chrome:, ftp:, blob: ...) is rejected. */
export function isSafeFetchUrl(input: string): boolean {
  return core.isSafeFetchUrl(input);
}

/**
 * True for a message sent by one of THIS extension's own pages (popup, options, side panel, background, offscreen).
 * A content script also has `sender.id === chrome.runtime.id`, but it runs next to a hostile page: it has a page address.
 */
export function isExtensionPage(sender: { id?: string; url?: string }): boolean {
  return (
    sender.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(chrome.runtime.getURL(''))
  );
}

/** A blob: URL created by this extension's own offscreen document (the only kind that may be handed to chrome.downloads). */
export function isOwnBlobUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith(`blob:${chrome.runtime.getURL('').replace(/\/$/, '')}/`);
}

export function isBlobUrl(input: string): boolean {
  return core.isBlobUrl(input);
}

/**
 * True for loopback, private (RFC 1918), link-local, unique-local and "local network" host names. Requests to such
 * hosts carry the user's network position and cookies, so a hostile page must not be able to aim the extension at them.
 */
export function isPrivateHost(hostname: string): boolean {
  return core.isPrivateHost(hostname);
}

/**
 * Whether the extension itself may fetch `target` on behalf of the page at `pageUrl`: private-network targets are
 * only allowed when the page is itself on a private host (a local media server the user is browsing).
 */
export function mayExtensionFetch(target: string, pageUrl: string): boolean {
  return core.mayExtensionFetch(target, pageUrl);
}

/**
 * Canonical form used for deduplication: no fragment, no userinfo, default port dropped,
 * query parameters sorted. The path is left untouched because paths are case/slash sensitive.
 */
/**
 * Canonical form used for deduplication: no fragment, no userinfo, default port dropped, query parameters sorted (by
 * code point). The path is left untouched because paths are case/slash sensitive.
 */
export function normalizeUrl(input: string): string {
  return core.normalizeUrl(input);
}

/** Never log full URLs: query strings and fragments often carry signed tokens. */
export function redactUrl(input: string): string {
  return core.redactUrl(input);
}

/** Replace any URL embedded in free text with its redacted form. */
export function redactText(text: string): string {
  return core.redactText(text);
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function redactArg(arg: unknown): unknown {
  if (typeof arg === 'string') return redactText(arg);
  if (arg instanceof Error) return redactText(arg.message);
  if (typeof arg === 'number' || typeof arg === 'boolean' || arg == null) return arg;
  try {
    return redactText(JSON.stringify(arg));
  } catch {
    return '[unserialisable]';
  }
}

/** Console wrapper that redacts URLs. Use instead of console.* anywhere a URL could appear. */
export const log: Record<LogLevel, (...args: unknown[]) => void> = {
  debug: (...a) => console.debug('[vdown]', ...a.map(redactArg)),
  info: (...a) => console.info('[vdown]', ...a.map(redactArg)),
  warn: (...a) => console.warn('[vdown]', ...a.map(redactArg)),
  error: (...a) => console.error('[vdown]', ...a.map(redactArg)),
};

/**
 * Sanitise a single file *base name* (no directory, no extension handling).
 * Result is never empty and is safe on Windows, macOS and Linux.
 */
export function sanitizeFilename(name: string, fallback = 'video', maxLength = 150): string {
  return core.sanitizeFilename(name, fallback, maxLength);
}

/** Sanitise a relative sub-folder path. Drops `..`, absolute prefixes and empty segments. Max 4 levels. */
export function sanitizeSubfolder(path: string): string {
  return core.sanitizeSubfolder(path);
}

/**
 * ASCII-only form of a file name, used when Chrome rejects the original ("Invalid filename" can happen on systems
 * whose locale cannot represent the characters). Accents are folded; anything else becomes "_".
 */
export function asciiFileName(name: string): string {
  return core.asciiFileName(name);
}

/** Ensure the final name ends with the given extension (case-insensitive), without doubling it. */
export function withExtension(base: string, ext: string): string {
  return core.withExtension(base, ext);
}

export interface NameTokens {
  title: string;
  host: string;
  resolution: string;
  date: string;
  format: string;
  id: string;
}

export const NAME_TOKENS: ReadonlyArray<keyof NameTokens> = [
  'title',
  'host',
  'resolution',
  'date',
  'format',
  'id',
];

/** Render a naming template. Unknown tokens are removed; empty `[]`/`()` leftovers are cleaned up. */
/** Render a naming template. Unknown tokens are removed; empty `[]`/`()` leftovers are cleaned up. */
export function renderNameTemplate(template: string, tokens: NameTokens): string {
  return core.renderNameTemplate(template, tokens);
}
