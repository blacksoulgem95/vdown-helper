/**
 * Page hook: runs in the page's own JavaScript world at document_start, in every frame, ONLY while the user has
 * enabled it (opt-in, needs site access). It watches, and never changes, what the page does:
 *   - fetch / XMLHttpRequest: remembers the URL and content type of requests, so manifests and files a player
 *     loads from script are found even when the browser's resource-timing buffer has overflowed or was cleared;
 *   - EME: remembers which key systems the page asks for, so protected playback is recognised and refused;
 *   - Media Source Extensions: remembers which MediaSource a blob: URL stands for and what is appended to its
 *     SourceBuffers. Nothing is recorded until the isolated-world capture controller (content/capture.ts) arms it
 *     for one MediaSource, at the user's request; only each SourceBuffer's latest initialisation segment is kept.
 * It sends nothing anywhere by itself. The extension reads it on demand (window.__vdhHook.drain()) when the user
 * scans. Everything is wrapped so a failure here can never break the page.
 */
interface HookRequest {
  url: string;
  contentType?: string;
  via: 'fetch' | 'xhr';
}

(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w['__vdhHook']) return; // already installed in this frame

  const MAX = 400;
  const requests: HookRequest[] = [];
  const seen = new Set<string>();
  const emeKeySystems = new Set<string>();

  function record(url: string, contentType: string | null | undefined, via: HookRequest['via']): void {
    try {
      const abs = new URL(url, document.baseURI).href;
      if (!/^https?:/i.test(abs)) return;
      const key = `${via}|${abs}`;
      if (seen.has(key)) return;
      if (requests.length >= MAX) requests.shift();
      seen.add(key);
      const r: HookRequest = { url: abs, via };
      if (contentType) r.contentType = contentType.slice(0, 200);
      requests.push(r);
    } catch {
      // ignore anything odd: the page must keep working
    }
  }

  try {
    const nativeFetch = window.fetch;
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const p = nativeFetch.apply(this, args);
      try {
        const input = args[0];
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        p.then(
          (res) => record(res.url || url, res.headers.get('content-type'), 'fetch'),
          () => undefined,
        );
      } catch {
        // never interfere
      }
      return p;
    };
  } catch {
    // fetch not patchable here
  }

  try {
    const proto = XMLHttpRequest.prototype;
    const nativeOpen = proto.open;
    const nativeSend = proto.send;
    const urls = new WeakMap<XMLHttpRequest, string>();
    proto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      try {
        urls.set(this, String(args[1]));
      } catch {
        // ignore
      }
      return (nativeOpen as (...a: unknown[]) => void).apply(this, args);
    } as typeof proto.open;
    proto.send = function (this: XMLHttpRequest, body?: Parameters<XMLHttpRequest['send']>[0]) {
      try {
        this.addEventListener('loadend', () => {
          try {
            record(this.responseURL || urls.get(this) || '', this.getResponseHeader('content-type'), 'xhr');
          } catch {
            // ignore
          }
        });
      } catch {
        // ignore
      }
      return nativeSend.call(this, body);
    };
  } catch {
    // XHR not patchable here
  }

  try {
    const nav = navigator as unknown as {
      requestMediaKeySystemAccess?: (...args: unknown[]) => Promise<unknown>;
    };
    const nativeRmksa = nav.requestMediaKeySystemAccess;
    if (nativeRmksa) {
      nav.requestMediaKeySystemAccess = function (this: unknown, ...args: unknown[]) {
        try {
          if (emeKeySystems.size < 8) emeKeySystems.add(String(args[0]).toLowerCase().slice(0, 100));
        } catch {
          // ignore
        }
        return nativeRmksa.apply(this, args);
      };
    }
  } catch {
    // EME not available (e.g. insecure context)
  }

  // ---- Media Source Extensions
  interface SbInfo {
    id: string;
    mime: string;
    ms: MediaSource;
    /** The latest initialisation segment appended (small): a recording that starts later still needs it. */
    lastInit?: ArrayBuffer;
  }
  const msUrls = new Map<string, MediaSource>(); // blob: URL -> MediaSource, kept after the URL is revoked
  const msBuffers = new WeakMap<MediaSource, SourceBuffer[]>();
  const sbInfo = new WeakMap<SourceBuffer, SbInfo>();
  let sbCounter = 0;
  let armed: MediaSource | undefined;

  /** Whether an appended chunk is an initialisation segment (fragmented MP4 with a moov box, or a WebM header). */
  function looksLikeInit(v: Uint8Array): boolean {
    if (v.length >= 4 && v[0] === 0x1a && v[1] === 0x45 && v[2] === 0xdf && v[3] === 0xa3) return true;
    let pos = 0;
    for (let n = 0; n < 8 && pos + 8 <= v.length; n++) {
      const size =
        ((v[pos] ?? 0) * 16777216 +
          ((v[pos + 1] ?? 0) << 16) +
          ((v[pos + 2] ?? 0) << 8) +
          (v[pos + 3] ?? 0)) >>>
        0;
      const type = String.fromCharCode(v[pos + 4] ?? 0, v[pos + 5] ?? 0, v[pos + 6] ?? 0, v[pos + 7] ?? 0);
      if (type === 'moov') return true;
      if (size < 8) return false;
      pos += size;
    }
    return false;
  }

  const viewOf = (data: BufferSource): Uint8Array =>
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(
          (data as ArrayBufferView).buffer,
          (data as ArrayBufferView).byteOffset,
          (data as ArrayBufferView).byteLength,
        );

  function emitChunk(info: SbInfo, buf: ArrayBuffer): void {
    window.postMessage({ __vdh: 'mse-chunk', sb: info.id, mime: info.mime, buf }, '*', [buf]);
  }

  try {
    const nativeCreate = URL.createObjectURL;
    URL.createObjectURL = function (this: unknown, obj: Blob | MediaSource) {
      const url = nativeCreate.call(this, obj as Blob);
      try {
        if (typeof MediaSource !== 'undefined' && obj instanceof MediaSource) {
          msUrls.set(url, obj);
          if (msUrls.size > 30) msUrls.delete(msUrls.keys().next().value as string);
        }
      } catch {
        // never interfere
      }
      return url;
    };
  } catch {
    // not patchable here
  }

  try {
    const nativeAdd = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
      const sb = nativeAdd.call(this, mime);
      try {
        sbInfo.set(sb, { id: String(++sbCounter), mime: String(mime).slice(0, 200), ms: this });
        msBuffers.set(this, [...(msBuffers.get(this) ?? []), sb]);
      } catch {
        // never interfere
      }
      return sb;
    };
    const nativeAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource) {
      try {
        const info = sbInfo.get(this);
        if (info) {
          const v = viewOf(data);
          const init = looksLikeInit(v);
          const recording = armed === info.ms;
          if (init || recording) {
            const copy = v.slice().buffer as ArrayBuffer; // our own copy: the page keeps using its buffer
            if (init) info.lastInit = copy.slice(0);
            if (recording) emitChunk(info, copy);
          }
        }
      } catch {
        // never interfere
      }
      return nativeAppend.call(this, data);
    };
  } catch {
    // MediaSource not available (e.g. a frame without it)
  }

  const removeAll = (sb: SourceBuffer): Promise<void> =>
    new Promise((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(done, 3000);
      const go = () => {
        try {
          sb.addEventListener('updateend', () => (clearTimeout(timer), done()), { once: true });
          sb.remove(0, Number.POSITIVE_INFINITY);
        } catch {
          clearTimeout(timer);
          done();
        }
      };
      if (sb.updating) sb.addEventListener('updateend', go, { once: true });
      else go();
    });

  // Commands from the extension's isolated-world controller (same window, different JavaScript world).
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const d = ev.data as { __vdh?: string; url?: unknown; token?: unknown; flush?: unknown } | null;
    if (!d || typeof d !== 'object') return;
    const reply = (extra: Record<string, unknown>) =>
      window.postMessage({ __vdh: 'mse-armed', token: d.token, ...extra }, '*');
    if (d.__vdh === 'mse-disarm') {
      armed = undefined;
      return;
    }
    if (d.__vdh !== 'mse-arm' || typeof d.url !== 'string') return;
    void (async () => {
      try {
        const ms = msUrls.get(d.url as string);
        if (!ms) return reply({ ok: false, reason: 'unknown-source' });
        if (ms.readyState === 'closed') return reply({ ok: false, reason: 'not-open' });
        if (!Number.isFinite(ms.duration) || ms.duration <= 0) return reply({ ok: false, reason: 'live' });
        const buffers = msBuffers.get(ms) ?? [];
        // Players do not re-append what is already buffered: empty the buffers so the playback that follows
        // makes them append (and us record) everything from the start.
        if (d.flush === true) await Promise.all(buffers.map(removeAll));
        armed = ms;
        for (const sb of buffers) {
          const info = sbInfo.get(sb);
          if (info?.lastInit) emitChunk(info, info.lastInit.slice(0));
        }
        reply({
          ok: true,
          duration: ms.duration,
          buffers: buffers.map((sb) => ({ id: sbInfo.get(sb)?.id, mime: sbInfo.get(sb)?.mime })),
        });
      } catch {
        reply({ ok: false, reason: 'error' });
      }
    })();
  });

  Object.defineProperty(window, '__vdhHook', {
    value: Object.freeze({
      /** Everything seen so far (kept: scans can repeat). */
      drain: () => ({
        requests: requests.slice(),
        emeKeySystems: [...emeKeySystems],
        mediaSources: [...msUrls].map(([url, ms]) => ({
          url,
          buffers: (msBuffers.get(ms) ?? []).map((sb) => ({
            id: sbInfo.get(sb)?.id,
            mime: sbInfo.get(sb)?.mime,
          })),
        })),
      }),
    }),
    enumerable: false,
    configurable: false,
  });
})();
