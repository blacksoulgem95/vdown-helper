// Installs each installer Tauri built for one target on this runner, runs the installed app's --self-test (which must
// find its bundled vdh-ffmpeg and vdh-ffprobe, not a system copy), and copies the installers, with a .sha256 file
// each, into the release folder.
//
//   node scripts/desktop/smoke-test.mjs --target x86_64-pc-windows-msvc --out desktop-release
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const target = arg('--target');
const out = resolve(root, arg('--out') ?? 'desktop-release');
if (!target) throw new Error('--target <triple> is required');
const bundle = join(root, 'target', target, 'release', 'bundle');
if (!existsSync(bundle)) throw new Error(`no bundle folder: ${bundle}`);

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (p.endsWith('.app') ? [p] : files(p)) : [p];
  });
}
const built = files(bundle);
const one = (re) => {
  const hits = built.filter((f) => re.test(basename(f)));
  if (hits.length !== 1)
    throw new Error(
      `expected one ${re} in ${bundle}, found ${hits.map((h) => basename(h)).join(', ') || 'none'}`,
    );
  return hits[0];
};

/** Run the installed app's self-test: it must pass and use its own bundled ffmpeg and ffprobe. */
function selfTest(program, env = {}) {
  const r = spawnSync(program, ['--self-test'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60000,
  });
  const line = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  let report;
  try {
    report = JSON.parse(line);
  } catch {
    throw new Error(
      `${program} --self-test: exit ${r.status}, stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr?.slice(-500))}`,
    );
  }
  console.log(`${program}: ${line}`);
  if (r.status !== 0 || !report.ok) throw new Error(`self-test failed: ${line}`);
  for (const k of ['ffmpeg', 'ffprobe'])
    if (!/vdh-ff(mpeg|probe)(\.exe)?$/.test(report[k]?.[0] ?? ''))
      throw new Error(`${k} is not the bundled one: ${line}`);
  if (report.version !== process.env.VDH_VERSION && process.env.VDH_VERSION)
    throw new Error(`version ${report.version}, expected ${process.env.VDH_VERSION}`);
  return report;
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const shipped = [];

if (target.includes('windows')) {
  // NSIS, per-user: installs under %LOCALAPPDATA%\vdown-helper
  const setup = one(/-setup\.exe$/);
  run(setup, ['/S']);
  const dir = join(process.env.LOCALAPPDATA ?? '', 'vdown-helper');
  selfTest(join(dir, 'vdown-helper.exe'));
  run(join(dir, 'uninstall.exe'), ['/S']);
  shipped.push(setup);
  // MSI, per-machine (the runner is an administrator), into a known folder, with a log to show when it fails
  const msi = one(/\.msi$/);
  const dir2 = join(process.env.RUNNER_TEMP ?? 'C:\\vdh', 'vdh-msi');
  const log = join(process.env.RUNNER_TEMP ?? 'C:\\vdh', 'vdh-msi.log');
  const installed = spawnSync(
    'msiexec',
    ['/i', msi, '/qn', '/norestart', `INSTALLDIR=${dir2}`, '/l*v', log],
    {
      stdio: 'inherit',
    },
  );
  const exe = join(dir2, 'vdown-helper.exe');
  if (installed.status !== 0 || !existsSync(exe)) {
    const text = existsSync(log) ? readFileSync(log, 'utf16le') : '(no log)';
    throw new Error(
      `msiexec exit ${installed.status}, ${exe} present: ${existsSync(exe)}\n${text.slice(-3000)}`,
    );
  }
  selfTest(exe);
  run('msiexec', ['/x', msi, '/qn', '/norestart']);
  shipped.push(msi);
} else if (target.includes('apple')) {
  const dmg = one(/\.dmg$/);
  const mount = '/tmp/vdh-dmg';
  run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
  try {
    const macos = join(mount, 'vdown-helper.app', 'Contents', 'MacOS');
    selfTest(join(macos, 'vdown-helper'));
    for (const p of ['vdown-helper', 'vdh-ffmpeg', 'vdh-ffprobe']) {
      const archs = execFileSync('lipo', ['-archs', join(macos, p)], { encoding: 'utf8' });
      if (!/x86_64/.test(archs) || !/arm64/.test(archs)) throw new Error(`${p} is not universal: ${archs}`);
    }
  } finally {
    run('hdiutil', ['detach', mount]);
  }
  shipped.push(dmg);
} else {
  const appimage = one(/\.AppImage$/);
  chmodSync(appimage, 0o755);
  selfTest(appimage, { APPIMAGE_EXTRACT_AND_RUN: '1' });
  const deb = one(/\.deb$/);
  run('sudo', ['apt-get', 'install', '-y', deb]);
  selfTest('/usr/bin/vdown-helper');
  run('sudo', ['apt-get', 'remove', '-y', 'vdown-helper']);
  const rpm = one(/\.rpm$/);
  const listed = execFileSync('rpm', ['-qlp', rpm], { encoding: 'utf8' });
  for (const f of ['/usr/bin/vdown-helper', '/usr/bin/vdh-ffmpeg', '/usr/bin/vdh-ffprobe'])
    if (!listed.split('\n').includes(f)) throw new Error(`${basename(rpm)} lacks ${f}:\n${listed}`);
  shipped.push(appimage, deb, rpm);
}

mkdirSync(out, { recursive: true });
for (const f of shipped) {
  const to = join(out, basename(f));
  copyFileSync(f, to);
  const sum = createHash('sha256').update(readFileSync(to)).digest('hex');
  writeFileSync(`${to}.sha256`, `${sum}  ${basename(f)}\n`);
  console.log(`release: ${basename(f)} (${statSync(to).size} bytes) ${sum}`);
}
