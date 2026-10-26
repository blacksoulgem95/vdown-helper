/** URL validation, redaction, and filename sanitisation. Pure functions, no chrome.* access. */

const ALLOWED_FETCH_PROTOCOLS = new Set(['http:', 'https:']);

/** Parse a URL, returning undefined instead of throwing. */
export function parseUrl(input: string, base?: string): URL | undefined {
  try {
    return base === undefined ? new URL(input) : new URL(input, base);
  } catch {
    return undefined;
  }
}

/** True for http(s) URLs only. Everything else (javascript:, data:, file:, chrome:, ftp:, blob: ...) is rejected. */
/** The longest address the extension will fetch. Real signed URLs stay well below this; a manifest cannot make it grow. */
export const MAX_URL_LENGTH = 8192;

export function isSafeFetchUrl(input: string): boolean {
  if (input.length > MAX_URL_LENGTH) return false;
  const url = parseUrl(input);
  return url !== undefined && ALLOWED_FETCH_PROTOCOLS.has(url.protocol);
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
  return parseUrl(input)?.protocol === 'blob:';
}

/**
 * True for loopback, private (RFC 1918), link-local, unique-local and "local network" host names. Requests to such
 * hosts carry the user's network position and cookies, so a hostile page must not be able to aim the extension at them.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.lan') ||
    h.endsWith('.home.arpa')
  ) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(':'))
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return !h.includes('.'); // single-label intranet names
}

/**
 * Whether the extension itself may fetch `target` on behalf of the page at `pageUrl`: private-network targets are
 * only allowed when the page is itself on a private host (a local media server the user is browsing).
 */
export function mayExtensionFetch(target: string, pageUrl: string): boolean {
  const t = parseUrl(target);
  if (!t || (t.protocol !== 'http:' && t.protocol !== 'https:')) return false;
  if (!isPrivateHost(t.hostname)) return true;
  const page = parseUrl(pageUrl);
  return page !== undefined && isPrivateHost(page.hostname);
}

/**
 * Canonical form used for deduplication: no fragment, no userinfo, default port dropped,
 * query parameters sorted. The path is left untouched because paths are case/slash sensitive.
 */
export function normalizeUrl(input: string): string {
  const url = parseUrl(input);
  if (!url) return input.trim();
  url.hash = '';
  url.username = '';
  url.password = '';
  const params = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  url.search = '';
  for (const [k, v] of params) url.searchParams.append(k, v);
  return url.toString();
}

/** Never log full URLs: query strings and fragments often carry signed tokens. */
export function redactUrl(input: string): string {
  // A data: URL is its own payload: show only the media type.
  if (/^data:/i.test(input)) return `data:${input.slice(5).split(/[;,]/)[0]?.slice(0, 100) ?? ''}`;
  const url = parseUrl(input);
  if (!url) return '[invalid-url]';
  const query = url.search ? '?…' : '';
  return `${url.protocol}//${url.host}${url.pathname}${query}`;
}

const URL_IN_TEXT = /\b(?:https?|blob):\/\/[^\s"'<>)]+/gi;

/** Replace any URL embedded in free text with its redacted form. */
export function redactText(text: string): string {
  return text.replace(URL_IN_TEXT, (m) => redactUrl(m.replace(/^blob:/i, '')));
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

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\uFEFF]/g;

/**
 * Sanitise a single file *base name* (no directory, no extension handling).
 * Result is never empty and is safe on Windows, macOS and Linux.
 */
export function sanitizeFilename(name: string, fallback = 'video', maxLength = 150): string {
  // "Live: the show" reads better as "Live - the show" than "Live_ the show" (a colon is not allowed on Windows).
  let out = name
    .normalize('NFC')
    .replace(/\s*:\s+/g, ' - ')
    .replace(ILLEGAL_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim();
  out = out.replace(/_{2,}/g, '_');
  out = out.replace(/^[.\s_]+|[.\s]+$/g, '');
  if (out.length > maxLength) out = out.slice(0, maxLength).replace(/[.\s]+$/, '');
  if (!out) return fallback;
  if (RESERVED_WINDOWS.test(out.split('.')[0] ?? '')) out = `_${out}`;
  return out;
}

/** Sanitise a relative sub-folder path. Drops `..`, absolute prefixes and empty segments. Max 4 levels. */
export function sanitizeSubfolder(path: string): string {
  return path
    .split(/[\\/]+/)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
    .map((seg) => sanitizeFilename(seg, '', 60))
    .filter((seg) => seg !== '')
    .slice(0, 4)
    .join('/');
}

/**
 * ASCII-only form of a file name, used when Chrome rejects the original ("Invalid filename" can happen on systems
 * whose locale cannot represent the characters). Accents are folded; anything else becomes "_".
 */
export function asciiFileName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/_{2,}/g, '_');
}

/** Ensure the final name ends with the given extension (case-insensitive), without doubling it. */
export function withExtension(base: string, ext: string): string {
  const e = ext.replace(/^\./, '').toLowerCase();
  return base.toLowerCase().endsWith(`.${e}`) ? base : `${base}.${e}`;
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
export function renderNameTemplate(template: string, tokens: NameTokens): string {
  const rendered = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    return (NAME_TOKENS as readonly string[]).includes(key) ? tokens[key as keyof NameTokens] : '';
  });
  const cleaned = rendered
    .replace(/\[\s*\]|\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return sanitizeFilename(cleaned, sanitizeFilename(tokens.title));
}
