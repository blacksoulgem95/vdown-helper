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
};

export function startServers(root, pagesDir) {
  const state = { flakyEnabled: false, hits: [] };

  const handler = (origin) => async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let path = decodeURIComponent(url.pathname);
    state.hits.push(`${origin} ${req.method} ${path}`);
    const headers = {};

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
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
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

  const a = createServer(handler('A'));
  const b = createServer(handler('B'));
  return new Promise((resolve) => {
    a.listen(0, '127.0.0.1', () =>
      b.listen(0, '127.0.0.1', () =>
        resolve({
          a: `http://127.0.0.1:${a.address().port}`,
          // "localhost" is a different origin from 127.0.0.1, so it is not covered by the test build's host grant.
          b: `http://localhost:${b.address().port}`,
          state,
          close: () => Promise.all([new Promise((r) => a.close(r)), new Promise((r) => b.close(r))]),
        }),
      ),
    );
  });
}
