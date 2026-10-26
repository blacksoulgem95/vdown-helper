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
    }
  /**
   * `blocked`: fetch() rejected. For cross-origin requests this means CORS refusal OR a network error; the
   * browser deliberately does not say which.
   */
  | { ok: false; kind: 'http' | 'blocked' | 'timeout'; status?: number };

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12_000;

type FetchLike = typeof fetch;

function failure(e: unknown): ProbeResult {
  const name = e instanceof Error ? e.name : '';
  return { ok: false, kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'blocked' };
}

/** HEAD, falling back to a one-byte ranged GET when HEAD is refused. Only headers are read. */
export async function probeHeaders(
  url: string,
  f: FetchLike = fetch,
  credentials: RequestCredentials = 'same-origin',
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
      return out;
    } catch (e) {
      return failure(e);
    }
  };
  const head = await attempt({ method: 'HEAD' });
  if (head.ok || head.kind === 'blocked' || head.kind === 'timeout') return head;
  return attempt({ method: 'GET', headers: { Range: 'bytes=0-0' } });
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
