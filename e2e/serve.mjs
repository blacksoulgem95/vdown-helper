// Starts the same fixture servers the E2E suite uses, for MANUAL testing with the unpacked extension.
//   npm run serve:fixtures      then open the printed "page" URL in Chrome with dist/ loaded.
import { join } from 'node:path';
import { ensureFixtures } from './fixtures.mjs';
import { startServers } from './server.mjs';

const here = import.meta.dirname;
const fixtures = join(here, '.tmp/fixtures');
ensureFixtures(fixtures);
const s = await startServers(fixtures, join(here, 'pages'));
console.log(`
Fixture servers are running (Ctrl+C to stop).

  Page to test      ${s.a}/pages/main.html?cdn=${encodeURIComponent(s.b)}
  Empty page        ${s.a}/pages/empty.html
  Worker page       ${s.a}/pages/worker.html     (needs the network observer enabled in Settings)
  Nested frames     ${s.a}/pages/frames-top.html?c=${encodeURIComponent(s.c)}&d=${encodeURIComponent(s.d)}
  MSE player        ${s.a}/pages/mse.html        (turn on "Look inside players" first)
  Real players      ${s.a}/pages/player-top.html?c=${encodeURIComponent(s.c)}&kind=hls   (or kind=dash)
  MediaStream       ${s.a}/pages/stream.html     (canvas + tone; ?audio=0 / ?video=0)
  Live HLS / DASH   ${s.a}/pages/live.html?src=hls/index.m3u8&id=a&len=60   (src=dash/manifest.mpd; len=7 ends; gone=3 drops a segment)
  Files and ZIP     ${s.a}/pages/files.html
  Metadata          ${s.a}/pages/meta.html
  PeerTube-shaped   ${s.a}/w/kkGMgK9ZtnKfYAgnEtQxbv
  Slow 2 MB file    ${s.a}/__slow/file.bin       (pause/resume)
  Enable flaky      curl -X POST ${s.a}/__flaky/enable   (then retry the failed job)

Note: access to ${s.a} must be granted to the extension (the toolbar action grants it for the active tab).
${s.b} plays the role of a CDN: /open/* sends CORS headers, /closed/* does not, /slow/* delays segments.
`);
