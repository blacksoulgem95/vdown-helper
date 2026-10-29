import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setMessageSource, t } from '@/lib/i18n';
import { setLanguage, td } from '../desktop/ui/src/i18n';

const ui = resolve(import.meta.dirname, '../desktop/ui');
type Catalog = Record<string, { message: string }>;
const load = (l: string) => JSON.parse(readFileSync(resolve(ui, 'locales', `${l}.json`), 'utf8')) as Catalog;
const nums = (s: string) =>
  [...s.matchAll(/\$([1-9])/g)]
    .map((m) => m[1])
    .sort()
    .join();

describe('desktop catalogs', () => {
  const en = load('en');
  const it_ = load('it');
  it('have identical keys, the same $n placeholders and no empty messages', () => {
    expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en)) {
      expect(nums(it_[k]?.message ?? ''), k).toBe(nums(en[k]?.message ?? ''));
      expect(en[k]?.message.trim(), `en:${k}`).not.toBe('');
      expect(it_[k]?.message.trim(), `it:${k}`).not.toBe('');
    }
  });
  it('have every key the window and the app use', () => {
    const src = resolve(ui, 'src');
    const used = new Set<string>();
    for (const f of readdirSync(src))
      for (const m of readFileSync(resolve(src, f), 'utf8').matchAll(/\btd\('([A-Za-z]+)'/g))
        used.add(m[1] ?? '');
    const native = readFileSync(resolve(ui, '../src-tauri/src/main.rs'), 'utf8');
    for (const m of native.matchAll(/"(notify[A-Za-z]+|tray[A-Za-z]+)"/g)) used.add(m[1] ?? '');
    expect(used.size).toBeGreaterThan(10);
    for (const k of used) expect(en[k], k).toBeDefined();
  });
});

describe('the window language', () => {
  afterEach(() => {
    setMessageSource(undefined);
  });
  it('switches the shared components and the app strings together', () => {
    setLanguage('it');
    expect(td('save')).toBe('Salva');
    expect(t('cancel')).toBe('Annulla');
    expect(document.documentElement.lang).toBe('it');
    setLanguage('en');
    expect(td('save')).toBe('Save');
    expect(t('cancel')).toBe('Cancel');
  });
  it('substitutes $n in both catalogs', () => {
    setLanguage('it');
    expect(td('finishedAt', 'ieri')).toBe('Terminato ieri');
  });
  it('falls back to English when the source has nothing', () => {
    setMessageSource(() => '');
    expect(t('cancel')).toBe('Cancel');
    setMessageSource(() => 'X');
    expect(t('cancel')).toBe('X');
  });
});
