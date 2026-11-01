// Fetches the pinned GPL builds of ffmpeg and ffprobe the desktop installers bundle (desktop/ffmpeg.lock.json), checks
// every download against its SHA-256 and places the programs where Tauri's externalBin expects them:
// desktop/src-tauri/binaries/vdh-{ffmpeg,ffprobe}-<target>[.exe] (installed as vdh-ffmpeg / vdh-ffprobe next to the
// app: a name no system package uses), with their licences in binaries/licenses/.
// For universal-apple-darwin the x86_64 and arm64 builds are joined with lipo.
//
//   node scripts/desktop/fetch-ffmpeg.mjs --target x86_64-pc-windows-msvc
//   node scripts/desktop/fetch-ffmpeg.mjs --print-hashes      (downloads every entry and prints its SHA-256)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const lock = JSON.parse(readFileSync(join(root, 'desktop/ffmpeg.lock.json'), 'utf8'));
const out = join(root, 'desktop/src-tauri/binaries');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Every file under `dir`, recursively. */
function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** Download, check and unpack one archive; returns the folder it was unpacked into. */
async function unpack(entry) {
  const buf = await download(entry.url);
  const got = sha256(buf);
  if (got !== entry.sha256) throw new Error(`${entry.url}: SHA-256 ${got}, expected ${entry.sha256}`);
  const dir = join(tmpdir(), `vdh-ffmpeg-${sha256(Buffer.from(entry.url)).slice(0, 12)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, basename(new URL(entry.url).pathname) || 'archive');
  writeFileSync(file, buf);
  if (/\.zip$/i.test(file) && process.platform === 'linux') execFileSync('unzip', ['-q', file, '-d', dir]);
  else if (/\.(zip|tar\.xz|tar\.gz|tgz|txz)$/i.test(file)) execFileSync('tar', ['-xf', file, '-C', dir]);
  else if (entry.program) copyFileSync(file, join(dir, entry.program)); // a bare executable
  return dir;
}

/** ffmpeg and ffprobe for one target triple: the folder(s) they were unpacked into. */
async function fetchTarget(triple) {
  const t = lock.targets[triple];
  if (!t) throw new Error(`no ffmpeg pinned for ${triple}`);
  const exe = triple.includes('windows') ? '.exe' : '';
  const dirs = [];
  for (const entry of t.archives) dirs.push(await unpack(entry));
  const pick = (name) => {
    for (const d of dirs) {
      const hits = files(d).filter((f) => basename(f) === name);
      if (hits.length === 1) return hits[0];
    }
    throw new Error(`${name} not found for ${triple}`);
  };
  return { ffmpeg: pick(`ffmpeg${exe}`), ffprobe: pick(`ffprobe${exe}`), dirs, exe };
}

function licenses(dirs, triple) {
  const dest = join(out, 'licenses');
  mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const d of dirs)
    for (const f of files(d).filter((x) => /^(LICENSE|COPYING)/i.test(basename(x)))) {
      copyFileSync(f, join(dest, `ffmpeg-${basename(f)}`));
      n++;
    }
  const t = lock.targets[triple];
  writeFileSync(
    join(dest, 'FFMPEG-NOTICE.txt'),
    [
      'The ffmpeg and ffprobe programs installed with vdown-helper are FFmpeg (https://ffmpeg.org), built with GPL',
      'components (x264, x265 and others) and distributed under the GNU General Public License, version 3 or later.',
      'They are separate programs that vdown-helper runs; vdown-helper itself is MIT-licensed.',
      '',
      `Build: ${t.build}`,
      `Download: ${t.archives.map((a) => a.url).join(' , ')}`,
      `Source code and build scripts: ${t.source}`,
      'FFmpeg source: https://ffmpeg.org/download.html',
      '',
    ].join('\n'),
  );
  if (n === 0) {
    // the archive carries no licence file: point at the GPL text
    writeFileSync(
      join(dest, 'ffmpeg-LICENSE.txt'),
      'GNU General Public License v3.0: https://www.gnu.org/licenses/gpl-3.0.txt\n',
    );
  }
}

if (process.argv.includes('--print-hashes')) {
  for (const [triple, t] of Object.entries(lock.targets))
    for (const entry of t.archives)
      console.log(`${triple}\t${sha256(await download(entry.url))}\t${entry.url}`);
  process.exit(0);
}

const target = arg('--target');
if (!target) throw new Error('--target <triple> is required');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
if (target === 'universal-apple-darwin') {
  const x = await fetchTarget('x86_64-apple-darwin');
  const a = await fetchTarget('aarch64-apple-darwin');
  for (const name of ['ffmpeg', 'ffprobe']) {
    const to = join(out, `vdh-${name}-${target}`);
    execFileSync('lipo', ['-create', x[name], a[name], '-output', to]);
    chmodSync(to, 0o755);
  }
  licenses([...x.dirs, ...a.dirs], 'aarch64-apple-darwin');
} else {
  const f = await fetchTarget(target);
  for (const name of ['ffmpeg', 'ffprobe']) {
    const to = join(out, `vdh-${name}-${target}${f.exe}`);
    copyFileSync(f[name], to);
    chmodSync(to, 0o755);
  }
  licenses(f.dirs, target);
}
for (const f of files(out)) console.log(`${f.slice(root.length + 1)}\t${statSync(f).size} bytes`);
if (!existsSync(join(out, 'licenses'))) throw new Error('no licences');
