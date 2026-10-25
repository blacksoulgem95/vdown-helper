import { describe, expect, it } from 'vitest';
import { parseEnvelope } from '@/lib/messaging';

const env = (type: string, payload: unknown) => ({ channel: 'vdown', type, payload });
const validRequest = {
  resourceId: 'abc',
  sourceUrl: 'https://a.com/v.mp4',
  tabId: 1,
  filename: 'v.mp4',
  subfolder: '',
  mode: 'original',
  container: 'original',
  audioFormat: 'mp3',
  audioBitrate: 192,
  isHls: false,
};

describe('parseEnvelope', () => {
  it('accepts well-formed messages', () => {
    expect(parseEnvelope(env('scan', { tabId: 3 }))).toBeTruthy();
    expect(parseEnvelope(env('job-action', { jobId: 'j1', action: 'cancel' }))).toBeTruthy();
    expect(parseEnvelope(env('start-download', { request: validRequest }))).toBeTruthy();
  });
  it.each([
    [null],
    ['scan'],
    [{ type: 'scan', payload: { tabId: 1 } }],
    [env('nope', {})],
    [env('scan', { tabId: '1' })],
    [env('scan', { tabId: -1 })],
    [env('job-action', { jobId: 'j', action: 'format-disk' })],
    [env('inspect-variant', { tabId: 1, url: '' })],
    [env('start-download', { request: { ...validRequest, mode: 'x' } })],
    [env('start-download', { request: { ...validRequest, audioBitrate: 1 } })],
    [env('start-download', {})],
  ])('rejects %j', (raw) => {
    expect(parseEnvelope(raw)).toBeUndefined();
  });
});
