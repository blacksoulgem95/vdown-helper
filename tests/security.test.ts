import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSafeFetchUrl,
  log,
  normalizeUrl,
  redactText,
  redactUrl,
  renderNameTemplate,
  sanitizeFilename,
  sanitizeSubfolder,
  withExtension,
} from '@/lib/security';

describe('isSafeFetchUrl', () => {
  it.each(['https://a.com/x.mp4', 'http://a.com/x'])('accepts %s', (u) => expect(isSafeFetchUrl(u)).toBe(true));
  it.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'chrome://settings', 'ftp://a/b', 'blob:https://a/1', 'not a url', ''])(
    'rejects %s',
    (u) => expect(isSafeFetchUrl(u)).toBe(false),
  );
});

describe('normalizeUrl', () => {
  it('drops fragments and userinfo, sorts query parameters', () => {
    expect(normalizeUrl('https://user:pw@A.com:443/v.mp4?b=2&a=1#t=5')).toBe('https://a.com/v.mp4?a=1&b=2');
  });
  it('keeps path case and trailing slash', () => {
    expect(normalizeUrl('https://a.com/Video/')).toBe('https://a.com/Video/');
  });
});

describe('redaction', () => {
  it('removes query, fragment and credentials from URLs', () => {
    expect(redactUrl('https://u:p@a.com/p/v.m3u8?token=SECRET#x')).toBe('https://a.com/p/v.m3u8?…');
    expect(redactUrl('nope')).toBe('[invalid-url]');
  });
  it('redacts URLs embedded in text', () => {
    expect(redactText('failed https://a.com/x.mp4?sig=SECRET twice')).toBe('failed https://a.com/x.mp4?… twice');
  });
  describe('log', () => {
    afterEach(() => vi.restoreAllMocks());
    it('never prints query strings', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      log.error('boom', new Error('GET https://a.com/x?token=SECRET failed'), { url: 'https://a.com/y?k=SECRET' });
      const printed = JSON.stringify(spy.mock.calls);
      expect(printed).not.toContain('SECRET');
    });
  });
});

describe('sanitizeFilename', () => {
  it('replaces illegal characters and collapses whitespace', () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j   k')).toBe('a_b_c_d_e_f_g_h_i_j k');
  });
  it('strips control and bidi override characters', () => {
    expect(sanitizeFilename('ab\u0000c\u202ed.mp4')).toBe('ab_c_d.mp4');
  });
  it('removes leading/trailing dots and spaces (no hidden files, no path tricks)', () => {
    expect(sanitizeFilename('..hidden. ')).toBe('hidden');
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc_passwd');
  });
  it('prefixes Windows reserved names', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('lpt1.txt')).toBe('_lpt1.txt');
  });
  it('falls back when nothing usable remains', () => {
    expect(sanitizeFilename('///')).toBe('video');
    expect(sanitizeFilename('...', 'x')).toBe('x');
  });
  it('limits length', () => {
    expect(sanitizeFilename('a'.repeat(500)).length).toBe(150);
  });
  it('keeps unicode text', () => {
    expect(sanitizeFilename('Città – 映画')).toBe('Città – 映画');
  });
});

describe('sanitizeSubfolder', () => {
  it('drops traversal, absolute prefixes, and limits depth', () => {
    expect(sanitizeSubfolder('../../x/./y')).toBe('x/y');
    expect(sanitizeSubfolder('/abs\\win/path')).toBe('abs/win/path');
    expect(sanitizeSubfolder('a/b/c/d/e/f')).toBe('a/b/c/d');
    expect(sanitizeSubfolder('')).toBe('');
  });
});

describe('withExtension / renderNameTemplate', () => {
  it('appends an extension once', () => {
    expect(withExtension('clip', 'mp4')).toBe('clip.mp4');
    expect(withExtension('clip.MP4', '.mp4')).toBe('clip.MP4');
  });
  const tokens = { title: 'My Clip', host: 'ex.com', resolution: '1080p', date: '2026-10-25', format: 'mp4', id: 'abc' };
  it('renders tokens', () => {
    expect(renderNameTemplate('{title} [{resolution}]', tokens)).toBe('My Clip [1080p]');
    expect(renderNameTemplate('{host}_{title}_{date}', tokens)).toBe('ex.com_My Clip_2026-10-25');
  });
  it('cleans up empty brackets and unknown tokens', () => {
    expect(renderNameTemplate('{title} [{resolution}]', { ...tokens, resolution: '' })).toBe('My Clip');
    expect(renderNameTemplate('{title}{bogus}', tokens)).toBe('My Clip');
  });
  it('sanitises the result, and falls back to the title when the template is empty', () => {
    expect(renderNameTemplate('{title}/../x', { ...tokens, title: 'a/b' })).toBe('a_b_.._x');
    expect(renderNameTemplate('', tokens)).toBe('My Clip');
  });
});
