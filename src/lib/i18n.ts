import en from '../../_locales/en/messages.json';

type Catalog = typeof en;
export type MessageKey = keyof Catalog;

/**
 * Localised string lookup. chrome.i18n picks the browser's UI language (en or it); when it has no
 * entry (or chrome.i18n is unavailable, e.g. in unit tests) the bundled English text is used.
 * `$1`..`$9` are positional substitutions.
 */
export function t(key: MessageKey, ...subs: Array<string | number>): string {
  const values = subs.map(String);
  let fromChrome = '';
  try {
    fromChrome = globalThis.chrome?.i18n?.getMessage(key, values) ?? '';
  } catch {
    fromChrome = '';
  }
  if (fromChrome) return fromChrome;
  const entry = (en as Record<string, { message: string }>)[key];
  const message = entry?.message ?? key;
  return message.replace(/\$([1-9])/g, (_m, n: string) => values[Number(n) - 1] ?? '');
}
