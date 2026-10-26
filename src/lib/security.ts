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
export function isSafeFetchUrl(input: string): boolean {
  const url = parseUrl(input);
  return url !== undefined && ALLOWED_FETCH_PROTOCOLS.has(url.protocol);
}

export function isBlobUrl(input: string): boolean {
  return parseUrl(input)?.protocol === 'blob:';
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
  let out = name.normalize('NFC').replace(ILLEGAL_CHARS, '_').replace(/\s+/g, ' ').trim();
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
