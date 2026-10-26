/**
 * Page hook: runs in the page's own JavaScript world at document_start, in every frame, ONLY while the user has
 * enabled it (opt-in, needs site access). It watches, and never changes, what the page does:
 *   - fetch / XMLHttpRequest: remembers the URL and content type of requests, so manifests and files a player
 *     loads from script are found even when the browser's resource-timing buffer has overflowed or was cleared;
 *   - EME: remembers which key systems the page asks for, so protected playback is recognised and refused.
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

  Object.defineProperty(window, '__vdhHook', {
    value: Object.freeze({
      /** Everything seen so far (kept: scans can repeat). */
      drain: () => ({ requests: requests.slice(), emeKeySystems: [...emeKeySystems] }),
    }),
    enumerable: false,
    configurable: false,
  });
})();
