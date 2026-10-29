import en from '../../_locales/en/messages.json';

type Catalog = typeof en;
export type MessageKey = keyof Catalog;

type Source = (key: string, values: string[]) => string;
let source: Source | undefined;

/** Where messages come from outside the extension (the desktop app picks its language itself); '' falls back. */
export function setMessageSource(fn: Source | undefined): void {
  source = fn;
}

/**
 * Localised string lookup. chrome.i18n picks the browser's UI language (en or it); when it has no
 * entry (or chrome.i18n is unavailable, e.g. in unit tests) the bundled English text is used.
 * `$1`..`$9` are positional substitutions.
 */
export function t(key: MessageKey, ...subs: Array<string | number>): string {
  const values = subs.map(String);
  let fromChrome: string;
  try {
    fromChrome = source ? source(key, values) : (globalThis.chrome?.i18n?.getMessage(key, values) ?? '');
  } catch {
    fromChrome = '';
  }
  if (fromChrome) return fromChrome;
  const entry = (en as Record<string, { message: string }>)[key];
  const message = entry?.message ?? key;
  return message.replace(/\$([1-9])/g, (_m, n: string) => values[Number(n) - 1] ?? '');
}
