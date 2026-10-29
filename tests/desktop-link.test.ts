import { describe, expect, it } from 'vitest';
import { cookieHeader, parseAppMessage, routeToDesktop, sanitizeDesktop } from '@/lib/desktop';
import { parseEnvelope } from '@/lib/messaging';
import type { DownloadRequest } from '@/types/download';

const req = (over: Partial<DownloadRequest> = {}): DownloadRequest =>
  ({
    resourceId: 'r',
    sourceUrl: 'https://cdn.example/a.mp4',
    tabId: 1,
    pageUrl: 'https://site.example/',
    host: 'site.example',
    mode: 'video-audio',
    container: 'mp4',
    audioFormat: 'mp3',
    audioBitrate: 192,
    filename: 'a.mp4',
    subfolder: '',
    qualityLabel: '720p',
    sourceFormat: 'mp4',
    isHls: false,
    hasMuxedAudio: true,
    hasVideo: true,
    ...over,
  }) as DownloadRequest;

describe('desktop settings', () => {
  it('are off by default and keep only known values', () => {
    expect(sanitizeDesktop(undefined)).toEqual({ enabled: false, routing: 'streams' });
    expect(sanitizeDesktop({ enabled: 'yes', routing: 'sometimes', extra: 1 })).toEqual({
      enabled: false,
      routing: 'streams',
    });
    expect(sanitizeDesktop({ enabled: true, routing: 'always' })).toEqual({
      enabled: true,
      routing: 'always',
    });
  });
});

describe('routing to the desktop app', () => {
  const on = (routing: 'never' | 'streams' | 'always') => ({ enabled: true, routing });
  const plain = { requiresFfmpeg: false };
  it('sends nothing while the app is off, even when asked', () => {
    expect(routeToDesktop(req({ isHls: true }), plain, { enabled: false, routing: 'always' }, true)).toBe(
      false,
    );
  });
  it('streams and conversions by default; files stay in Chrome', () => {
    expect(routeToDesktop(req({ isHls: true }), plain, on('streams'), false)).toBe(true);
    expect(routeToDesktop(req({ isDash: true }), plain, on('streams'), false)).toBe(true);
    expect(routeToDesktop(req(), { requiresFfmpeg: true }, on('streams'), false)).toBe(true);
    expect(routeToDesktop(req(), plain, on('streams'), false)).toBe(false);
  });
  it('never and always; the card button overrides never', () => {
    expect(routeToDesktop(req({ isHls: true }), plain, on('never'), false)).toBe(false);
    expect(routeToDesktop(req({ isHls: true }), plain, on('never'), true)).toBe(true);
    expect(routeToDesktop(req(), plain, on('always'), false)).toBe(true);
  });
  it('page-held media, ZIPs and subtitles always stay in the browser', () => {
    for (const over of [
      { held: { kind: 'blob' } },
      { capture: { speed: 'fast' } },
      { record: { prefer: 'webm' } },
      { zip: { resourceIds: [], items: [], left: 0 } },
      { subtitle: { output: 'srt' } },
    ] as Array<Partial<DownloadRequest>>)
      expect(routeToDesktop(req(over), plain, on('always'), true)).toBe(false);
  });
});

describe('cookie header', () => {
  it('joins the cookies and leaves out any that could break the header', () => {
    expect(
      cookieHeader([
        { name: 'sid', value: 'a1' },
        { name: 'x', value: 'b\r\nEvil: 1' },
        { name: '', value: 'c' },
        { name: 'lang', value: 'it' },
      ]),
    ).toBe('sid=a1; lang=it');
  });
});

describe('messages from the app', () => {
  it('need protocol version 1 and a known type', () => {
    expect(parseAppMessage({ v: 2, type: 'hello', appVersion: '1' })).toBeUndefined();
    expect(parseAppMessage({ v: 1, type: 'run-shell' })).toBeUndefined();
    expect(parseAppMessage('hello')).toBeUndefined();
    expect(parseAppMessage({ v: 1, type: 'hello', appVersion: '0.1.0', ffmpeg: '7.1' })).toEqual({
      type: 'hello',
      appVersion: '0.1.0',
      ffmpeg: '7.1',
    });
  });
  it('carry only known stages, codes and finite progress', () => {
    expect(parseAppMessage({ v: 1, type: 'stage', jobId: 'j', stage: 'exploding' })).toBeUndefined();
    expect(parseAppMessage({ v: 1, type: 'error', jobId: 'j', code: 'weird', message: 'm' })).toEqual({
      type: 'error',
      jobId: 'j',
      code: 'unknown',
      message: 'm',
    });
    expect(
      parseAppMessage({
        v: 1,
        type: 'progress',
        jobId: 'j',
        progress: { fraction: 3, bytesDone: -1, unitsDone: 4, evil: 'x', etaSeconds: Infinity },
      }),
    ).toEqual({ type: 'progress', jobId: 'j', progress: { fraction: 1, unitsDone: 4 } });
    expect(
      parseAppMessage({ v: 1, type: 'accepted', jobId: 'j', stages: ['preparing', 'nope'] }),
    ).toBeUndefined();
  });
  it('done, cancelled, needs-cookies and status', () => {
    expect(parseAppMessage({ v: 1, type: 'done', jobId: 'j', path: '/d/a.mp4', bytes: 10 })).toEqual({
      type: 'done',
      jobId: 'j',
      path: '/d/a.mp4',
      bytes: 10,
    });
    expect(parseAppMessage({ v: 1, type: 'done', jobId: 'j' })).toBeUndefined();
    expect(parseAppMessage({ v: 1, type: 'needs-cookies', jobId: 'j', origins: ['https://a'] })).toEqual({
      type: 'needs-cookies',
      jobId: 'j',
      origins: ['https://a'],
    });
    expect(
      parseAppMessage({
        v: 1,
        type: 'status',
        jobs: [
          { jobId: 'a', stage: 'downloading', paused: true, progress: { fraction: 0.5 } },
          { jobId: 'b', stage: 'gone' },
          { jobId: 'c', stage: 'failed', error: { code: 'protected', message: 'DRM' } },
        ],
      }),
    ).toEqual({
      type: 'status',
      jobs: [
        { jobId: 'a', stage: 'downloading', paused: true, progress: { fraction: 0.5 } },
        { jobId: 'b', stage: 'gone' },
        { jobId: 'c', stage: 'failed', error: { code: 'protected', message: 'DRM' } },
      ],
    });
    expect(parseAppMessage({ v: 1, type: 'status', jobs: [{ jobId: 'a', stage: 'odd' }] })).toBeUndefined();
  });
});

describe('the start-download message', () => {
  const payload = (desktop: unknown) => ({
    channel: 'vdown',
    type: 'start-download',
    payload: { request: req(), desktop },
  });
  it('takes an optional desktop flag, and only a boolean', () => {
    expect(parseEnvelope(payload(true))).toBeDefined();
    expect(parseEnvelope(payload(undefined))).toBeDefined();
    expect(parseEnvelope(payload('yes'))).toBeUndefined();
  });
});
