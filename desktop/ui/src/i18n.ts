/**
 * The window's strings: its own catalogs (`desktop/ui/locales`) for what only the app says, and the extension's for
 * the shared components. The app decides the language (Settings, or the system's) and both follow it.
 */
import { setMessageSource } from '@/lib/i18n';
import extIt from '../../../_locales/it/messages.json';
import en from '../locales/en.json';
import it from '../locales/it.json';

export type Lang = 'en' | 'it';
export type DesktopKey = keyof typeof en;
type Catalog = Record<string, { message: string } | undefined>;

let lang: Lang = 'en';

const fill = (message: string, values: string[]) =>
  message.replace(/\$([1-9])/g, (_m, n: string) => values[Number(n) - 1] ?? '');

export function setLanguage(next: Lang): void {
  lang = next;
  document.documentElement.lang = next;
  // English is the shared components' own fallback; Italian comes from the extension's catalog.
  setMessageSource((key, values) => {
    const entry = lang === 'it' ? (extIt as Catalog)[key] : undefined;
    return entry ? fill(entry.message, values) : '';
  });
}

/** A string of the app's own catalog. */
export function td(key: DesktopKey, ...subs: Array<string | number>): string {
  const catalog: Catalog = lang === 'it' ? it : en;
  const entry = catalog[key] ?? (en as Catalog)[key];
  return fill(entry?.message ?? key, subs.map(String));
}
