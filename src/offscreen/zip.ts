import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { zipLimitBytes } from '@/lib/request';
import type { DownloadRequest, JobProgress } from '@/types/download';
import { CancelledError, PipelineError } from './errors';
import { credentialsFor, getBytes } from './hls';
import { createStageFile } from './opfs';

/** One file is held in memory while it is added; bigger files are skipped (and listed), not truncated. */
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export interface ZipResult {
  file: File;
  bytes: number;
  /** Files that could not be added (also named inside the archive). */
  failed: number;
}

const text = (s: string) => new TextEncoder().encode(s);

/**
 * Fetch the files of a ZIP job one by one and write a classic ZIP to disk as it grows. A file that cannot be fetched is
 * skipped and named in `_not-saved.txt` inside the archive; the job only fails when nothing at all could be added or
 * the archive would exceed the size limit (the limit is enforced while writing, not just estimated up front).
 */
export async function buildZip(
  jobId: string,
  req: DownloadRequest,
  maxMemoryMb: number,
  signal: AbortSignal,
  onProgress: (p: JobProgress) => void,
): Promise<ZipResult> {
  const items = req.zip?.items ?? [];
  if (items.length === 0) throw new PipelineError('invalid', 'There is nothing to put in the ZIP');
  const limit = zipLimitBytes(maxMemoryMb);
  const creds = credentialsFor(req.credentialedOrigins, { pageUrl: req.pageUrl, owner: req.pageUrl });
  const out = await createStageFile(jobId, 'bundle.zip');

  let writing: Promise<void> = Promise.resolve();
  let zipError: Error | undefined;
  const zip = new Zip((err, chunk) => {
    if (err) {
      zipError = err;
      return;
    }
    writing = writing.then(() => out.write(chunk));
  });
  const flush = async () => {
    await writing;
    if (zipError) throw new PipelineError('unknown', 'The ZIP could not be written');
    if (out.bytes > limit) throw new PipelineError('too-large', 'The ZIP is larger than the allowed size');
  };

  const failed: string[] = [];
  let added = 0;
  try {
    for (const [i, item] of items.entries()) {
      if (signal.aborted) throw new CancelledError();
      let data: Uint8Array;
      try {
        data = await getBytes(
          item.url,
          signal,
          creds,
          undefined,
          Math.min(MAX_FILE_BYTES, limit - out.bytes),
        );
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        if (signal.aborted) throw new CancelledError();
        const reason = e instanceof PipelineError ? e.code : 'error';
        failed.push(`${item.name} (${reason})`);
        onProgress({
          fraction: (i + 1) / items.length,
          unitsDone: i + 1,
          unitsTotal: items.length,
          bytesDone: out.bytes,
        });
        continue;
      }
      const entry = item.deflate ? new ZipDeflate(item.name, { level: 6 }) : new ZipPassThrough(item.name);
      zip.add(entry);
      entry.push(data, true);
      await flush();
      added++;
      onProgress({
        fraction: (i + 1) / items.length,
        unitsDone: i + 1,
        unitsTotal: items.length,
        bytesDone: out.bytes,
      });
    }
    if (added === 0) throw new PipelineError('network', 'None of the files could be downloaded');
    if (failed.length > 0 || (req.zip?.left ?? 0) > 0) {
      const note = new ZipDeflate('_not-saved.txt', { level: 6 });
      zip.add(note);
      note.push(
        text(
          `These files were not saved:\n${failed.map((f) => `- ${f}`).join('\n')}\n` +
            ((req.zip?.left ?? 0) > 0
              ? `${req.zip?.left} more selected file(s) were left out (embedded in the page, unavailable, or over the item limit).\n`
              : ''),
        ),
        true,
      );
    }
    zip.end();
    await flush();
    const file = await out.finish();
    return { file, bytes: out.bytes, failed: failed.length };
  } catch (e) {
    zip.terminate();
    await out.abort();
    throw e;
  }
}
