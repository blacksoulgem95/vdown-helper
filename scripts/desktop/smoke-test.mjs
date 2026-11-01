// Installs each installer Tauri built for one target on this runner, runs the installed app's --self-test (which must
// find its bundled vdh-ffmpeg and vdh-ffprobe, not a system copy), and copies the installers, under their fixed release
// names (desktop/release-assets.json) and with a .sha256 file each, into the release folder.
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
// only this build's installers (their names carry the version), whatever an earlier build left in the folder
const version = process.env.VDH_VERSION;
const built = files(bundle).filter((f) => !version || basename(f).includes(version));
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
  const local = join(process.env.LOCALAPPDATA ?? '', 'vdown-helper');
  const programFiles = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'vdown-helper');
  // MSI first, on a clean machine: Tauri's MSI reuses the folder of an earlier install it finds in the registry
  // (an NSIS one included), so after NSIS it would land in that folder instead
  const msi = one(/\.msi$/);
  const log = join(process.env.RUNNER_TEMP ?? 'C:\\vdh', 'vdh-msi.log');
  const installed = spawnSync('msiexec', ['/i', msi, '/qn', '/norestart', '/l*v', log], { stdio: 'inherit' });
  const msiExe = [programFiles, local].map((d) => join(d, 'vdown-helper.exe')).find((f) => existsSync(f));
  if (installed.status !== 0 || !msiExe) {
    const text = existsSync(log) ? readFileSync(log, 'utf16le') : '(no log)';
    const dirs = text
      .split('\n')
      .filter((l) => /INSTALLDIR|APPLICATIONFOLDER/.test(l))
      .slice(-10)
      .join('\n');
    throw new Error(`msiexec exit ${installed.status}, app not found\n${dirs}\n${text.slice(-2000)}`);
  }
  selfTest(msiExe);
  run('msiexec', ['/x', msi, '/qn', '/norestart']);
  shipped.push(['msi', msi]);
  // NSIS, per-user: installs under %LOCALAPPDATA%\vdown-helper
  const setup = one(/-setup\.exe$/);
  run(setup, ['/S']);
  selfTest(join(local, 'vdown-helper.exe'));
  run(join(local, 'uninstall.exe'), ['/S']);
  shipped.push(['setup', setup]);
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
  shipped.push(['dmg', dmg]);
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
  shipped.push(['appimage', appimage], ['deb', deb], ['rpm', rpm]);
}

// Released under fixed names (desktop/release-assets.json), so .../releases/latest/download/<name> always works (the site
// links them); the version is in the release.
const assets = Object.values(JSON.parse(readFileSync(join(root, 'desktop/release-assets.json'), 'utf8')));
mkdirSync(out, { recursive: true });
for (const [kind, f] of shipped) {
  const asset = assets.find((a) => a.target === target && a.kind === kind);
  if (!asset) throw new Error(`no release name for ${target} ${kind} (desktop/release-assets.json)`);
  const to = join(out, asset.file);
  copyFileSync(f, to);
  const sum = createHash('sha256').update(readFileSync(to)).digest('hex');
  writeFileSync(`${to}.sha256`, `${sum}  ${asset.file}\n`);
  console.log(`release: ${asset.file} (from ${basename(f)}, ${statSync(to).size} bytes) ${sum}`);
}
const expected = assets.filter((a) => a.target === target).length;
if (shipped.length !== expected)
  throw new Error(`shipped ${shipped.length} installers for ${target}, expected ${expected}`);
