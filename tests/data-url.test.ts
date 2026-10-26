import { describe, expect, it } from 'vitest';
import { dataHandle, dataLabel, exceedsHeldLimit, inspectDataUrl, isDataLabel } from '@/lib/dataUrl';
import { redactUrl, isSafeFetchUrl } from '@/lib/security';
import { MAX_HELD_BYTES } from '@/types/ingest';

describe('inspectDataUrl', () => {
  it('measures base64 payloads exactly, with padding', () => {
    expect(inspectDataUrl('data:video/mp4;base64,QUJD')).toEqual({
      mime: 'video/mp4',
      base64: true,
      bytes: 3,
    });
    expect(inspectDataUrl('data:audio/mpeg;base64,QUI=')?.bytes).toBe(2);
    expect(inspectDataUrl('data:audio/mpeg;base64,QQ==')?.bytes).toBe(1);
  });
  it('measures percent-encoded payloads', () => {
    expect(inspectDataUrl('data:audio/wav,%FF%FB%90abc')).toEqual({
      mime: 'audio/wav',
      base64: false,
      bytes: 6,
    });
  });
  it('lower-cases the type, defaults an empty one, and rejects the malformed', () => {
    expect(inspectDataUrl('DATA:Video/MP4;charset=x;base64,AA==')?.mime).toBe('video/mp4');
    expect(inspectDataUrl('data:,hi')?.mime).toBe('text/plain');
    for (const bad of [
      'http://a.com/x',
      'data:video/mp4',
      'data:not a mime,abc',
      `data:${'a'.repeat(400)}/b,x`,
      'data:/x,y',
    ])
      expect(inspectDataUrl(bad)).toBeUndefined();
  });
  it('knows when a payload is over the limit', () => {
    expect(exceedsHeldLimit(MAX_HELD_BYTES)).toBe(false);
    expect(exceedsHeldLimit(MAX_HELD_BYTES + 1)).toBe(true);
  });
});

describe('labels', () => {
  it('stands in for the URL without the payload, and is never fetchable', () => {
    const url = `data:video/mp4;base64,${'A'.repeat(5000)}`;
    const label = dataLabel('video/mp4', dataHandle(url));
    expect(label).toMatch(/^data:video\/mp4;vdh=[0-9a-f]{8}$/);
    expect(isDataLabel(label)).toBe(true);
    expect(isSafeFetchUrl(label)).toBe(false);
    expect(isSafeFetchUrl(url)).toBe(false);
    expect(label.length).toBeLessThan(60);
  });
  it('is stable, and different for different data', () => {
    const a = `data:video/mp4;base64,${'A'.repeat(100)}`;
    expect(dataHandle(a)).toBe(dataHandle(a));
    expect(dataHandle(a)).not.toBe(dataHandle(`${a}B`));
  });
  it('accepts nothing else as a label', () => {
    for (const bad of [
      'data:video/mp4;base64,AAAA',
      'data:video/mp4;vdh=xyz',
      'data:video/mp4;vdh=0123456789',
      'https://a.com/x',
      'data:video/mp4;vdh=01234567,extra',
      '',
    ])
      expect(isDataLabel(bad)).toBe(false);
  });
  it('is redacted to its media type, never its payload', () => {
    expect(redactUrl('data:video/mp4;base64,AAAA')).toBe('data:video/mp4');
    expect(redactUrl('data:audio/mpeg,%FF')).toBe('data:audio/mpeg');
  });
});
