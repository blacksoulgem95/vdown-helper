import { describe, expect, it } from 'vitest';
import { mergeNotes } from '@/background/detect';
import {
  hookCandidates,
  isInteresting,
  markProtectedFrames,
  parseHookReport,
  protectedKeySystems,
} from '@/lib/hookData';
import { buildReplayRule, replayDomains, replayHeadersFor, ruleIdFor } from '@/lib/replay';
import type { ScanReport } from '@/types/media';
import { makeResource } from './helpers';

describe('parseHookReport (the page controls this data)', () => {
  it('keeps well-formed http(s) requests and drops everything else', () => {
    const r = parseHookReport({
      requests: [
        {
          url: 'https://cdn.example/master.m3u8',
          via: 'fetch',
          contentType: 'application/vnd.apple.mpegurl',
        },
        { url: 'javascript:alert(1)', via: 'fetch' },
        { url: 'data:text/plain,x', via: 'xhr' },
        { url: 'file:///etc/passwd' },
        { url: 123 },
        null,
        'x',
        { url: 'https://cdn.example/' + 'a'.repeat(5000) },
      ],
      emeKeySystems: ['com.widevine.alpha', 'Org.W3.ClearKey', '<script>', 5, 'x'.repeat(500)],
    });
    expect(r.requests.map((x) => x.url)).toEqual(['https://cdn.example/master.m3u8']);
    expect(r.emeKeySystems).toEqual(['com.widevine.alpha', 'org.w3.clearkey']);
  });
  it('survives garbage and caps the amount of data', () => {
    for (const junk of [undefined, null, 5, 'x', [], { requests: 'no' }, { emeKeySystems: {} }]) {
      expect(() => parseHookReport(junk)).not.toThrow();
    }
    const many = { requests: Array.from({ length: 5000 }, (_, i) => ({ url: `https://a.com/${i}.mp4` })) };
    expect(parseHookReport(many).requests.length).toBeLessThanOrEqual(300);
    expect(
      parseHookReport({ emeKeySystems: Array(100).fill('a.b') }).emeKeySystems.length,
    ).toBeLessThanOrEqual(8);
  });
});

describe('hookCandidates', () => {
  it('turns manifests and media into candidates tagged with their frame, and ignores segments and noise', () => {
    const report = parseHookReport({
      requests: [
        { url: 'https://cdn.example/a/master.m3u8?x=1', via: 'fetch' },
        { url: 'https://cdn.example/a/master.m3u8?x=1#frag', via: 'xhr' }, // duplicate
        { url: 'https://cdn.example/a/seg1.ts', via: 'fetch' },
        { url: 'https://cdn.example/a/seg1.m4s', via: 'fetch' },
        {
          url: 'https://cdn.example/api/play',
          via: 'fetch',
          contentType: 'application/dash+xml; charset=utf-8',
        },
        { url: 'https://cdn.example/api/blob', via: 'fetch', contentType: 'video/mp4' },
        { url: 'https://cdn.example/app.js', via: 'fetch', contentType: 'text/javascript' },
        { url: 'https://cdn.example/captions.vtt', via: 'fetch' },
      ],
    });
    const c = hookCandidates(report, { frameId: 7, frameUrl: 'https://embed.example/player' });
    expect(c.map((x) => x.url)).toEqual([
      'https://cdn.example/a/master.m3u8?x=1',
      'https://cdn.example/api/play',
      'https://cdn.example/api/blob',
      'https://cdn.example/captions.vtt',
    ]);
    expect(
      c.every((x) => x.method === 'hook' && x.frameId === 7 && x.frameUrl === 'https://embed.example/player'),
    ).toBe(true);
    expect(c[1]?.mimeType).toBe('application/dash+xml');
  });
  it('isInteresting is conservative', () => {
    expect(isInteresting({ url: 'https://a.com/x.mpd', via: 'fetch' })).toBe(true);
    expect(isInteresting({ url: 'https://a.com/x.png', via: 'fetch' })).toBe(false);
    expect(isInteresting({ url: 'https://a.com/x.ts', via: 'fetch' })).toBe(false);
  });
});

describe('DRM key systems', () => {
  it('Widevine/PlayReady/FairPlay are protected, ClearKey is not', () => {
    expect(protectedKeySystems(['org.w3.clearkey', 'com.widevine.alpha', 'com.microsoft.playready'])).toEqual(
      ['com.widevine.alpha', 'com.microsoft.playready'],
    );
    expect(protectedKeySystems(['org.w3.clearkey'])).toEqual([]);
  });
  it('marks every resource of a frame that asked for DRM as protected, and only that frame', () => {
    const inFrame = makeResource('https://cdn.example/a.mp4', { frameId: 3 });
    const other = makeResource('https://cdn.example/b.mp4', { frameId: 0 });
    const none = makeResource('https://cdn.example/c.mp4');
    const out = markProtectedFrames([inFrame, other, none], new Map([[3, ['com.widevine.alpha']]]));
    expect(out[0]?.downloadability).toEqual({
      status: 'protected',
      reason: 'eme',
      detail: 'com.widevine.alpha',
    });
    expect(out[1]?.downloadability.status).toBe('unknown');
    expect(out[2]?.downloadability.status).toBe('unknown');
    expect(markProtectedFrames([other], new Map())).toEqual([other]);
  });
});

describe('header replay', () => {
  it("replays only the owning frame's origin, in the least revealing form", () => {
    expect(replayHeadersFor('https://embed.example/player/v?id=1&token=SECRET#x')).toEqual({
      referer: 'https://embed.example/',
      origin: 'https://embed.example',
    });
    expect(replayHeadersFor('http://127.0.0.2:8080/p')).toEqual({
      referer: 'http://127.0.0.2:8080/',
      origin: 'http://127.0.0.2:8080',
    });
    for (const bad of [undefined, '', 'javascript:x', 'data:text/html,x', 'chrome://x', 'not a url']) {
      expect(replayHeadersFor(bad)).toBeUndefined();
    }
  });
  it("limits a rule to the job's own hosts", () => {
    expect(
      replayDomains([
        'https://a.example/x',
        'https://a.example:8443/y',
        'http://b.example/z',
        'ftp://c/x',
        'bad',
      ]),
    ).toEqual(['a.example', 'b.example']);
    expect(replayDomains(Array.from({ length: 100 }, (_, i) => `https://h${i}.example/`)).length).toBe(24);
  });
  it('builds a rule that sets exactly Referer and Origin, only for tab-less requests to those hosts', () => {
    const rule = buildReplayRule(1_000_042, { referer: 'https://e.example/', origin: 'https://e.example' }, [
      'cdn.example',
    ]);
    expect(rule.action.requestHeaders?.map((h) => [h.header, h.operation, h.value])).toEqual([
      ['referer', 'set', 'https://e.example/'],
      ['origin', 'set', 'https://e.example'],
    ]);
    expect(rule.condition).toMatchObject({ requestDomains: ['cdn.example'], tabIds: [-1] });
  });
  it('rule ids are stable per job and kept in a private range', () => {
    expect(ruleIdFor('job-1')).toBe(ruleIdFor('job-1'));
    expect(ruleIdFor('job-1')).not.toBe(ruleIdFor('job-2'));
    expect(ruleIdFor('x')).toBeGreaterThanOrEqual(1_000_000);
  });
});

describe('mergeNotes (several frames)', () => {
  const report = (url: string, blocked: string[], blob = 0, frames = 0): ScanReport => ({
    pageUrl: url,
    pageTitle: '',
    candidates: [],
    notes: { blobSources: blob, inaccessibleFrames: frames, blockedFrameOrigins: blocked },
  });
  it('sums counts and lists only frames nobody could scan', () => {
    const notes = mergeNotes([
      report('https://top.example/', ['https://embed.example', 'https://ads.example'], 1, 2),
      report('https://embed.example/player', [], 2, 0), // scanned: no longer blocked
    ]);
    expect(notes).toEqual({
      blobSources: 3,
      inaccessibleFrames: 2,
      blockedFrameOrigins: ['https://ads.example'],
    });
  });
  it('tolerates frames without a usable URL and old reports', () => {
    const old = {
      pageUrl: 'about:blank',
      pageTitle: '',
      candidates: [],
      notes: { blobSources: 0, inaccessibleFrames: 0 },
    } as unknown as ScanReport;
    expect(mergeNotes([old]).blockedFrameOrigins).toEqual([]);
  });
});
