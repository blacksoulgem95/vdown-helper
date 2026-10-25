import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { t } from '@/lib/i18n';
import { installFakeChrome } from './helpers/fake-chrome';

const dir = resolve(import.meta.dirname, '../_locales');
const load = (l: string) => JSON.parse(readFileSync(resolve(dir, l, 'messages.json'), 'utf8')) as Record<string, { message: string }>;

describe('catalogs', () => {
  const locales = readdirSync(dir);
  it('ships en and it', () => expect(locales.sort()).toEqual(['en', 'it']));
  it('have identical keys', () => {
    expect(Object.keys(load('it')).sort()).toEqual(Object.keys(load('en')).sort());
  });
  it('use the same $n placeholders in both languages', () => {
    const en = load('en');
    const it_ = load('it');
    const nums = (s: string) => [...s.matchAll(/\$([1-9])/g)].map((m) => m[1]).sort().join();
    for (const k of Object.keys(en)) expect(nums(it_[k]?.message ?? ''), k).toBe(nums(en[k]?.message ?? ''));
  });
  it('have no empty messages', () => {
    for (const l of ['en', 'it']) for (const [k, v] of Object.entries(load(l))) expect(v.message.trim(), `${l}:${k}`).not.toBe('');
  });
});

describe('t()', () => {
  beforeEach(() => void installFakeChrome());
  it('falls back to the English catalog and substitutes $n', () => {
    expect(t('extName')).toBe('vdown-helper');
  });
  it('prefers chrome.i18n when it has a message', () => {
    (globalThis as unknown as { chrome: { i18n: { getMessage: () => string } } }).chrome.i18n.getMessage = () => 'CIAO';
    expect(t('extName')).toBe('CIAO');
  });
});
