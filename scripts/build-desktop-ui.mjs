// Builds the desktop app's window (desktop/ui) into desktop/ui/dist, which the Tauri app embeds.
// It shares the extension's components, theme, fonts, catalogs and Rust core (src/, _locales/, src/lib/core.ts).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
// a file: URL, not a path: on Windows an absolute path ("D:\...") is not a module specifier
const { baseConfig } = await import(pathToFileURL(resolve(root, 'vite.shared.ts')).href);
const react = (await import('@vitejs/plugin-react')).default;
const tailwindcss = (await import('@tailwindcss/vite')).default;

// The Rust core first: the shared components format sizes and stages with it.
execFileSync('node', [resolve(root, 'scripts/build-core.mjs')], { stdio: 'inherit' });

const base = baseConfig();
const ui = resolve(root, 'desktop/ui');
await build({
  ...base,
  root: ui,
  base: './',
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: {
    ...base.build,
    // the system web views: WebView2 (Windows), WKWebView (macOS 11+), WebKitGTK 4.1 (Linux)
    target: ['chrome105', 'safari15'],
    outDir: resolve(ui, 'dist'),
    // the Rust core is inlined (the window loads nothing from elsewhere)
    chunkSizeWarningLimit: 4096,
    emptyOutDir: true,
  },
});

// The window's own root is desktop/ui, and Tailwind only detects classes under the build's root: the shared components
// in src/ are scanned because the theme declares them (@source in src/styles/theme.css). Without that, the classes only
// they use are missing and the tabs render as one run of text (VDH-087). Check a shared component's classes made it in.
const assets = resolve(ui, 'dist/assets');
const css = readdirSync(assets)
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(assets, f), 'utf8'))
  .join('\n');
const shared = readFileSync(resolve(root, 'src/components/Tabs.tsx'), 'utf8');
// the class names in its one-line string literals ("…" and '…'), e.g. className="mb-2.5 flex …" and cx('mono …')
const classes = [...shared.matchAll(/(["'])([^"'\n]*)\1/g)]
  .flatMap((m) => (m[2] ?? '').split(/\s+/))
  .filter((c) => /^[a-z0-9!-][\w:/.[\]%-]*-[\w:/.[\]%-]*$/.test(c));
const missing = classes.filter((c) => !css.includes(`.${c.replace(/[.[\]/:%]/g, '\\$&')}`));
if (classes.length < 10 || missing.length > 0)
  throw new Error(
    `the desktop window's CSS lacks shared component classes: ${missing.join(' ') || '(none found)'}`,
  );
console.log('desktop window built ->', resolve(ui, 'dist'), `(${classes.length} shared classes checked)`);
