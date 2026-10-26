// Packages dist/ into release/vdown-helper-<version>.zip, the format Chrome (Load unpacked after unzipping) and the
// Chrome Web Store expect: manifest.json at the root of the archive. Run `npm run build` first (the `package` npm
// script does both). Cross-platform: no `zip` binary needed. Prints the zip path and its SHA-256.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { zipSync } from 'fflate';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const outDir = join(root, 'release');

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json not found: run `npm run build` first.');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`dist/manifest.json is ${manifest.version} but package.json is ${pkg.version}: rebuild.`);
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name)) // stable order, so identical input gives an identical zip
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

// A fixed timestamp keeps the archive reproducible (no build-time clock inside it).
const mtime = new Date('2026-01-01T00:00:00Z');
const files = {};
for (const file of walk(dist)) {
  const name = relative(dist, file).split(sep).join('/');
  if (name.endsWith('.map') || name.startsWith('.')) continue; // never ship source maps or dotfiles
  files[name] = [readFileSync(file), { level: name.endsWith('.wasm') ? 9 : 6, mtime }];
}
if (!('manifest.json' in files)) throw new Error('manifest.json would not be at the zip root');

mkdirSync(outDir, { recursive: true });
const zipPath = join(outDir, `vdown-helper-${pkg.version}.zip`);
writeFileSync(zipPath, zipSync(files));
const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
writeFileSync(`${zipPath}.sha256`, `${sha}  vdown-helper-${pkg.version}.zip\n`);

const mb = (n) => (n / 1048576).toFixed(1);
console.log(
  `${Object.keys(files).length} files -> ${relative(root, zipPath)} (${mb(statSync(zipPath).size)} MB)`,
);
console.log(`sha256 ${sha}`);
