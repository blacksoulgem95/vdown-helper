import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startChromeDownload } from '@/background/runner';
import type { DownloadRequest } from '@/types/download';
import { installFakeChrome } from './helpers/fake-chrome';

const req = (filename: string, subfolder = ''): DownloadRequest => ({
  resourceId: 'r',
  sourceUrl: 'https://a.com/v.mp4',
  tabId: 1,
  pageUrl: 'https://a.com/',
  host: 'a.com',
  mode: 'original',
  container: 'original',
  audioFormat: 'mp3',
  audioBitrate: 192,
  filename,
  subfolder,
  qualityLabel: '',
  sourceFormat: 'mp4',
  isHls: false,
  hasMuxedAudio: true,
  hasVideo: true,
});

function withDownloads(download: (o: chrome.downloads.DownloadOptions) => Promise<number>) {
  const fake = installFakeChrome() as unknown as { downloads?: unknown };
  const fn = vi.fn(download);
  fake.downloads = { download: fn };
  return fn;
}

describe('startChromeDownload', () => {
  beforeEach(() => void installFakeChrome());

  it('passes the sub-folder, uniquify and the Save-as choice to Chrome', async () => {
    const dl = withDownloads(async () => 7);
    const id = await startChromeDownload('https://a.com/v.mp4', {
      ...req('Clip.mp4', 'vdown'),
      saveAs: true,
    });
    expect(id).toBe(7);
    expect(dl).toHaveBeenCalledWith({
      url: 'https://a.com/v.mp4',
      filename: 'vdown/Clip.mp4',
      conflictAction: 'uniquify',
      saveAs: true,
    });
  });

  it('retries once with an ASCII-only name when Chrome says "Invalid filename"', async () => {
    const dl = withDownloads(async (o) => {
      if (/[^\x20-\x7e]/.test(o.filename ?? '')) throw new Error('Invalid filename');
      return 9;
    });
    const id = await startChromeDownload('https://a.com/v.mp4', req('Città — già [720p].mp4'));
    expect(id).toBe(9);
    expect(dl).toHaveBeenCalledTimes(2);
    expect(dl.mock.calls[1]?.[0].filename).toBe('Citta _ gia [720p].mp4');
  });

  it('does not retry other errors, nor when the name is already ASCII', async () => {
    const dl = withDownloads(async () => {
      throw new Error('Invalid filename');
    });
    await expect(startChromeDownload('https://a.com/v.mp4', req('plain.mp4'))).rejects.toThrow(
      'Invalid filename',
    );
    expect(dl).toHaveBeenCalledTimes(1);
    const other = withDownloads(async () => {
      throw new Error('Download canceled');
    });
    await expect(startChromeDownload('https://a.com/v.mp4', req('è.mp4'))).rejects.toThrow(
      'Download canceled',
    );
    expect(other).toHaveBeenCalledTimes(1);
  });
});
