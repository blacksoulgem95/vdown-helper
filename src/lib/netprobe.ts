/**
 * Small fetch helpers shared by the content script (page origin) and the service worker (extension origin).
 * They only read headers or capped text, and report failures as data, never exceptions.
 */
export type ProbeResult =
  | {
      ok: true;
      status: number;
      contentType: string;
      contentLength?: number;
      acceptRanges: boolean;
      finalUrl: string;
      text?: string;
      /** The file name a `Content-Disposition` header gives, as sent (sanitised by whoever uses it). */
      dispositionName?: string;
      /**
       * When the declared type says nothing useful (empty, octet-stream, or a script's default text/html), the first
       * bytes of the body and the type a GET declares: the caller tells what the file is from its magic numbers (the
       * sniffer lives in the shared core, which page scripts do not load).
       */
      sample?: { contentType: string; bytes: number[] };
    }
  /**
   * `blocked`: fetch() rejected. For cross-origin requests this means CORS refusal OR a network error; the
   * browser deliberately does not say which.
   */
  | { ok: false; kind: 'http' | 'blocked' | 'timeout'; status?: number };

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Enough for every magic number the sniffer knows (an MP4 `ftyp` box, a Matroska header naming its doc type). */
export const SAMPLE_BYTES = 600;
/** Declared types that do not say what a file is: a script's response is often one of these. */
const VAGUE_TYPE =
  /^(|application\/octet-stream|binary\/octet-stream|application\/x-download|text\/html|text\/plain)$/;
const TIMEOUT_MS = 12_000;

type FetchLike = typeof fetch;

function failure(e: unknown): ProbeResult {
  const name = e instanceof Error ? e.name : '';
  return { ok: false, kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'blocked' };
}

/** The file name in a `Content-Disposition` header (`filename*=UTF-8''…` preferred over `filename=…`). */
export function dispositionName(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star?.[2]) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')) || undefined;
    } catch {
      // a malformed escape: fall back to the plain parameter
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const name = (plain?.[2] ?? plain?.[1])?.trim();
  return name || undefined;
}

/**
 * The first bytes of a body, from a ranged GET (servers that ignore Range send the whole file, or an endless stream:
 * only the first chunks are read, then the request is cancelled).
 */
async function sampleBody(
  url: string,
  f: FetchLike,
  credentials: RequestCredentials,
): Promise<{ contentType: string; bytes: number[] } | undefined> {
  try {
    const res = await f(url, {
      credentials,
      cache: 'no-store',
      headers: { Range: `bytes=0-${SAMPLE_BYTES - 1}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const bytes: number[] = [];
    const reader = res.body?.getReader();
    if (reader) {
      while (bytes.length < SAMPLE_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const b of value.subarray(0, SAMPLE_BYTES - bytes.length)) bytes.push(b);
      }
      void reader.cancel().catch(() => undefined);
    }
    return { contentType: res.headers.get('content-type') ?? '', bytes };
  } catch {
    return undefined;
  }
}

/**
 * HEAD, falling back to a one-byte ranged GET when HEAD is refused. Only headers are read, unless the declared type is
 * vague (`sample`): then the first bytes are read too, so the caller can tell a script-served video from a page.
 */
export async function probeHeaders(
  url: string,
  f: FetchLike = fetch,
  credentials: RequestCredentials = 'same-origin',
  sample = true,
): Promise<ProbeResult> {
  const attempt = async (init: RequestInit): Promise<ProbeResult> => {
    try {
      const res = await f(url, {
        ...init,
        credentials,
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      void res.body?.cancel().catch(() => undefined);
      if (!res.ok && res.status !== 206) return { ok: false, kind: 'http', status: res.status };
      const total = res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length');
      const n = total ? Number(total) : NaN;
      const out: ProbeResult = {
        ok: true,
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        acceptRanges:
          (res.headers.get('accept-ranges') ?? '').toLowerCase() === 'bytes' || res.status === 206,
        finalUrl: res.url || url,
      };
      if (Number.isFinite(n) && n > 0) out.contentLength = n;
      const name = dispositionName(res.headers.get('content-disposition'));
      if (name) out.dispositionName = name;
      return out;
    } catch (e) {
      return failure(e);
    }
  };
  const head = await attempt({ method: 'HEAD' });
  const got =
    head.ok || head.kind === 'blocked' || head.kind === 'timeout'
      ? head
      : await attempt({ method: 'GET', headers: { Range: 'bytes=0-0' } });
  if (!got.ok || !sample || !VAGUE_TYPE.test(got.contentType.split(';')[0]?.trim().toLowerCase() ?? ''))
    return got;
  const body = await sampleBody(url, f, credentials);
  return body ? { ...got, sample: body } : got;
}

/** GET a text resource such as a playlist, capped at MAX_TEXT_BYTES. */
export async function fetchText(
  url: string,
  f: FetchLike = fetch,
  credentials: RequestCredentials = 'same-origin',
): Promise<ProbeResult> {
  try {
    const res = await f(url, { credentials, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, kind: 'http', status: res.status };
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_TEXT_BYTES) {
          await reader.cancel();
          return { ok: false, kind: 'http', status: 413 };
        }
        chunks.push(value);
      }
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      acceptRanges: false,
      finalUrl: res.url || url,
      text: new TextDecoder().decode(buf),
    };
  } catch (e) {
    return failure(e);
  }
}
