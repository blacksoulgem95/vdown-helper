import { describe, expect, it } from 'vitest';
import {
  describeCodecs,
  estimateBytes,
  formatBitrate,
  formatBytes,
  formatDuration,
  formatFromMime,
  formatFromUrl,
  inferTitle,
  mediaTypeOf,
  qualityTag,
} from '@/lib/media';

describe('formatting', () => {
  it('formats bytes, durations and bitrates', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(undefined)).toBe('');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(NaN)).toBe('');
    expect(formatBitrate(2_800_000)).toBe('2.8 Mbps');
    expect(formatBitrate(640_000)).toBe('640 kbps');
    expect(formatBitrate(0)).toBe('');
  });
});

describe('quality tags are derived from real heights', () => {
  it.each([
    [2160, '4K UHD'],
    [1440, 'QHD'],
    [1080, 'Full HD'],
    [720, 'HD'],
    [480, 'SD'],
    [360, 'Low'],
    [undefined, ''],
  ])('%s -> %s', (h, tag) => expect(qualityTag(h)).toBe(tag));
});

describe('format detection', () => {
  it('maps MIME types (ignoring parameters/case) and extensions', () => {
    expect(formatFromMime('Video/MP4; codecs="avc1"')).toBe('mp4');
    expect(formatFromMime('application/vnd.apple.mpegurl')).toBe('hls');
    expect(formatFromMime('audio/x-mpegurl')).toBe('m3u');
    expect(formatFromMime('text/html')).toBeUndefined();
    expect(formatFromUrl('https://a.com/x/clip.WEBM?x=1')).toBe('webm');
    expect(formatFromUrl('https://a.com/x/master.m3u8')).toBe('hls');
    expect(formatFromUrl('https://a.com/x/list.m3u')).toBe('m3u');
    expect(formatFromUrl('https://a.com/x/noext')).toBeUndefined();
    const urls: Array<[string, string]> = [
      ['a.flv', 'flv'],
      ['a.AVI', 'avi'],
      ['a.wmv', 'wmv'],
      ['a.asf', 'asf'],
      ['a.3gp', '3gp'],
      ['a.3g2', '3gp'],
      ['a.mpg', 'mpg'],
      ['a.mpeg', 'mpg'],
      ['a.aiff', 'aiff'],
      ['a.aif', 'aiff'],
      ['a.wma', 'wma'],
      ['a.opus', 'opus'],
    ];
    for (const [file, fmt] of urls) expect(formatFromUrl(`https://a.com/${file}`)).toBe(fmt);
    const mimes: Array<[string, string]> = [
      ['video/x-flv', 'flv'],
      ['video/x-msvideo', 'avi'],
      ['video/x-ms-wmv', 'wmv'],
      ['video/x-ms-asf', 'asf'],
      ['video/3gpp', '3gp'],
      ['video/mpeg', 'mpg'],
      ['audio/aiff', 'aiff'],
      ['audio/x-ms-wma', 'wma'],
      ['audio/opus', 'opus'],
    ];
    for (const [mime, fmt] of mimes) expect(formatFromMime(mime)).toBe(fmt);
  });
  it('classifies audio vs video', () => {
    expect(mediaTypeOf('mp3')).toBe('audio');
    expect(mediaTypeOf('hls')).toBe('video');
    for (const f of ['aiff', 'wma', 'opus'] as const) expect(mediaTypeOf(f)).toBe('audio');
    for (const f of ['flv', 'avi', 'wmv', 'asf', '3gp', 'mpg'] as const) expect(mediaTypeOf(f)).toBe('video');
    expect(mediaTypeOf('unknown')).toBe('unknown');
  });
});

describe('inferTitle', () => {
  it('prefers explicit title, then a meaningful filename, then the page title', () => {
    expect(inferTitle({ url: 'https://a.com/v/x.mp4', elementTitle: ' Hello  World ' })).toBe('Hello World');
    expect(inferTitle({ url: 'https://a.com/v/my_cool%20clip.mp4' })).toBe('my cool clip');
    expect(inferTitle({ url: 'https://a.com/v/master.m3u8', pageTitle: 'Page T' })).toBe('Page T');
    expect(inferTitle({ url: 'https://a.com/v/12345.ts', pageTitle: '' })).toBe('a.com');
  });
});

describe('describeCodecs', () => {
  it('identifies common codecs', () => {
    expect(describeCodecs('avc1.64001f,mp4a.40.2')).toEqual({
      video: { family: 'h264', label: 'H.264' },
      audio: { family: 'aac', label: 'AAC' },
    });
    expect(describeCodecs('hvc1.1.6.L93.B0,ec-3').video?.family).toBe('hevc');
    expect(describeCodecs('vp09.00.10.08,opus')).toMatchObject({
      video: { family: 'vp9' },
      audio: { family: 'opus' },
    });
    expect(describeCodecs(undefined)).toEqual({});
    expect(describeCodecs('zzz')).toEqual({});
  });
});

describe('estimateBytes', () => {
  it('computes from bitrate and duration, or returns undefined', () => {
    expect(estimateBytes(8_000_000, 10)).toBe(10_000_000);
    expect(estimateBytes(undefined, 10)).toBeUndefined();
    expect(estimateBytes(1000, 0)).toBeUndefined();
  });
});
