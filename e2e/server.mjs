// Two local origins for the E2E run:
//   A  http://127.0.0.1:PORT_A  the "website": pages + media, no CORS headers. The test build is granted access to it.
//   B  http://localhost:PORT_B  a "CDN" on another origin the extension has NOT been granted:
//        /open/**    answers Access-Control-Allow-Origin: *      (typical CDN)
//        /closed/**  sends no CORS headers                       (cross-origin blocked)
//        /slow/**    like /open but delays each response (cancel test)
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m3u': 'audio/x-mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.bin': 'application/octet-stream',
  '.vtt': 'text/vtt; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.woff2': 'font/woff2',
  '.flv': 'video/x-flv',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.asf': 'video/x-ms-asf',
  '.3gp': 'video/3gpp',
  '.mpg': 'video/mpeg',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
  '.opus': 'audio/opus',
  '.srt': 'application/x-subrip',
  '.ttml': 'application/ttml+xml',
};

const NM = join(import.meta.dirname, '..', 'node_modules');
const LIBS = {
  'hls.min.js': join(NM, 'hls.js/dist/hls.min.js'),
  'dash.all.min.js': join(NM, 'dashjs/dist/modern/umd/dash.all.min.js'),
};

export function startServers(root, pagesDir) {
  const state = { flakyEnabled: false, hits: [] };

  const handler = (origin) => async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let path = decodeURIComponent(url.pathname);
    state.hits.push(`${origin} ${req.method} ${path}`);
    const headers = {};
    let ignoreRange = false;
    // /__norange/<path> serves <path> but pretends Range is unsupported (always answers 200 with the whole file).
    if (origin === 'A' && path.startsWith('/__norange/')) {
      path = path.slice('/__norange'.length);
      ignoreRange = true;
    }
    // /__stall/<path>: sends the first bytes, then goes silent.
    if (origin === 'A' && path.startsWith('/__stall/')) {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': 1000000 });
      res.write(Buffer.alloc(1000, 1));
      return;
    }

    if (origin === 'B') {
      const m = /^\/(open|closed|slow)(\/.*)$/.exec(path);
      if (!m) return void res.writeHead(404).end();
      path = m[2];
      if (m[1] !== 'closed') {
        headers['Access-Control-Allow-Origin'] = '*';
        headers['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Accept-Ranges';
        headers['Access-Control-Allow-Headers'] = 'Range';
        if (req.method === 'OPTIONS') return void res.writeHead(204, headers).end();
      }
      if (m[1] === 'slow' && path.endsWith('.ts')) await new Promise((r) => setTimeout(r, 1500));
    }

    // Test players (hls.js, dash.js) are dev dependencies served from node_modules, on every origin: pages in nested
    // frames load their own copy. They are never part of the extension.
    if (req.method === 'GET' && path.startsWith('/__lib/')) {
      const lib = LIBS[path.slice('/__lib/'.length)];
      if (!lib || !existsSync(lib)) return void res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return void createReadStream(lib).pipe(res);
    }

    // A file that looks fine to a HEAD request (so it can be selected) but whose body fails: for the ZIP "not saved" list.
    if (origin === 'A' && path === '/__headok/report.pdf') {
      if (req.method === 'HEAD')
        return void res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': 10 }).end();
      return void res.writeHead(500).end('boom');
    }

    if (origin === 'A' && req.method === 'POST' && path === '/__flaky/enable') {
      state.flakyEnabled = true;
      return void res.writeHead(204).end();
    }

    // A 2 MB file trickled out over ~4 s, for pause/resume.
    if (origin === 'A' && path === '/__slow/file.bin') {
      const total = 2 * 1024 * 1024;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': total,
        'Content-Disposition': 'attachment; filename="slow.bin"',
      });
      let sent = 0;
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        const n = Math.min(100 * 1024, total - sent);
        res.write(Buffer.alloc(n, 7));
        sent += n;
        if (sent >= total) {
          clearInterval(timer);
          res.end();
        }
      }, 200);
      return;
    }

    // /__ref/<path>?need=<origin>: only answers requests that look like they come from that page (hotlink protection).
    if (path.startsWith('/__ref/')) {
      const need = url.searchParams.get('need') ?? '';
      const referer = String(req.headers.referer ?? '');
      const originHdr = req.headers.origin ? String(req.headers.origin) : '';
      const okReferer = need !== '' && referer.startsWith(`${need}/`);
      const okOrigin = originHdr === '' || originHdr === need;
      state.hits.push(
        `ref-check need=${need} referer=${referer || '-'} origin=${originHdr || '-'} -> ${okReferer && okOrigin}`,
      );
      if (!okReferer || !okOrigin) return void res.writeHead(403, headers).end('hotlinking is not allowed');
      path = path.slice('/__ref'.length);
    }

    // The flaky playlist's segments are real files, but 404 until enabled.
    let file;
    if (path.startsWith('/flaky/seg')) {
      if (!state.flakyEnabled) return void res.writeHead(404, headers).end('not yet');
      file = join(root, 'hls/v360', path.replace('/flaky/', ''));
    } else if (path.startsWith('/pages/')) {
      file = join(pagesDir, path.slice('/pages/'.length));
    } else {
      file = normalize(join(root, path));
      if (!file.startsWith(root)) return void res.writeHead(403).end();
    }
    if (!existsSync(file) || statSync(file).isDirectory()) return void res.writeHead(404, headers).end();
    const size = statSync(file).size;
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    headers['Content-Type'] = type;
    headers['Accept-Ranges'] = 'bytes';
    headers['Cache-Control'] = 'no-store';
    const range = ignoreRange ? null : /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return void res.end();
      return void createReadStream(file, { start, end }).pipe(res);
    }
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  };

  // A = the "website", B = a CDN that is not granted, C and D = extra origins for nested iframes (127.0.0.x are all
  // loopback addresses on Linux, and each is a different origin from every other).
  const hosts = { A: '127.0.0.1', B: '127.0.0.1', C: '127.0.0.2', D: '127.0.0.3' };
  const names = { A: '127.0.0.1', B: 'localhost', C: '127.0.0.2', D: '127.0.0.3' };
  const servers = Object.fromEntries(Object.keys(hosts).map((k) => [k, createServer(handler(k))]));
  return new Promise((resolve) => {
    let pending = Object.keys(servers).length;
    for (const [k, srv] of Object.entries(servers)) {
      srv.listen(0, hosts[k], () => {
        if (--pending > 0) return;
        const base = (k) => `http://${names[k]}:${servers[k].address().port}`;
        resolve({
          a: base('A'),
          b: base('B'),
          c: base('C'),
          d: base('D'),
          state,
          close: () => Promise.all(Object.values(servers).map((srv2) => new Promise((r) => srv2.close(r)))),
        });
      });
    }
  });
}
