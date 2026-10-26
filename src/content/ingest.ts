/**
 * Hands bytes that only this page holds (data: URLs) to the extension. The data is decoded here, inside the page that
 * owns it, and sent to the offscreen document over a port in acknowledged base64 chunks. The extension itself never
 * fetches a data: URL.
 */
import {
  INGEST_CHUNK_BYTES,
  INGEST_PORT_PREFIX,
  MAX_HELD_BYTES,
  type IngestDown,
  type IngestUp,
} from '@/types/ingest';

export type PumpResult = { ok: true; bytes: number } | { ok: false; error: string };

/** Base64 of a blob slice, computed natively (no big intermediate strings in script). */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read-failed'));
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.slice(s.lastIndexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** A data: URL decoded by the page itself (the extension never fetches it). */
export async function pumpData(jobId: string, dataUrl: string): Promise<PumpResult> {
  let blob: Blob;
  try {
    blob = await (await fetch(dataUrl)).blob();
  } catch {
    return { ok: false, error: 'The page data could not be decoded' };
  }
  return pumpBlob(jobId, blob, MAX_HELD_BYTES);
}

/** Stream a Blob the page holds to the offscreen document of `jobId`, at most `limit` bytes. */
export async function pumpBlob(jobId: string, blob: Blob, limit: number): Promise<PumpResult> {
  if (blob.size > limit) return { ok: false, error: 'The embedded data is larger than the allowed size' };

  const port = chrome.runtime.connect({ name: `${INGEST_PORT_PREFIX}${jobId}` });
  const inbox: IngestDown[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  port.onMessage.addListener((m: IngestDown) => {
    inbox.push(m);
    wake?.();
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    wake?.();
  });
  const next = async (): Promise<IngestDown | undefined> => {
    while (inbox.length === 0 && !closed) await new Promise<void>((r) => (wake = r));
    return inbox.shift();
  };
  const expect = async (t: IngestDown['t']): Promise<IngestDown> => {
    const m = await next();
    if (!m) throw new Error('The extension closed the connection');
    if (m.t === 'abort') throw new Error(m.message);
    if (m.t !== t) throw new Error('Unexpected reply from the extension');
    return m;
  };
  const send = (m: IngestUp) => port.postMessage(m);

  try {
    await expect('ready');
    send({ t: 'begin', mime: blob.type || 'application/octet-stream', total: blob.size });
    let seq = 0;
    for (let off = 0; off < blob.size; off += INGEST_CHUNK_BYTES) {
      send({ t: 'chunk', seq, b64: await toBase64(blob.slice(off, off + INGEST_CHUNK_BYTES)) });
      await expect('ack');
      seq++;
    }
    send({ t: 'end', chunks: seq });
    await expect('done');
    return { ok: true, bytes: blob.size };
  } catch (e) {
    try {
      send({ t: 'error', message: e instanceof Error ? e.message.slice(0, 200) : 'failed' });
    } catch {
      // the port is already gone
    }
    return { ok: false, error: e instanceof Error ? e.message : 'failed' };
  } finally {
    port.disconnect();
  }
}
