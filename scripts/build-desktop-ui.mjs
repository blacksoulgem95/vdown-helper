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
const { writeAllUtilities } = await import(
  pathToFileURL(resolve(root, 'scripts/desktop/tailwind-all.mjs')).href
);

// The Rust core first: the shared components format sizes and stages with it.
execFileSync('node', [resolve(root, 'scripts/build-core.mjs')], { stdio: 'inherit' });

const base = baseConfig();
const ui = resolve(root, 'desktop/ui');
// every utility, for the window's own stylesheet (desktop/ui/src/styles.css, VDH-088)
const utilities = await writeAllUtilities(
  resolve(root, 'src/styles/theme.css'),
  resolve(ui, '.generated/tailwind-all.css'),
);
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

// The window's stylesheet must hold every utility Tailwind lists (VDH-088) and the classes the shared components use.
// Those come from the scan the theme declares (@source in src/styles/theme.css): the window's own root is desktop/ui, and
// without it the tabs rendered as one run of text (VDH-087).
const assets = resolve(ui, 'dist/assets');
const css = readdirSync(assets)
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(assets, f), 'utf8'))
  .join('\n');
// the class selectors in the CSS, unescaped ("\\." -> ".", "\\:" -> ":")
const selectors = new Set(
  [...css.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => (m[1] ?? '').replace(/\\(.)/g, '$1')),
);
const shared = readFileSync(resolve(root, 'src/components/Tabs.tsx'), 'utf8');
// the class names in its one-line string literals ("…" and '…'), e.g. className="mb-2.5 flex …" and cx('mono …')
const classes = [...shared.matchAll(/(["'])([^"'\n]*)\1/g)]
  .flatMap((m) => (m[2] ?? '').split(/\s+/))
  .filter((c) => /^[a-z0-9!-][\w:/.[\]%-]*-[\w:/.[\]%-]*$/.test(c));
const missingShared = classes.filter((c) => !selectors.has(c));
if (classes.length < 10 || missingShared.length > 0)
  throw new Error(
    `the desktop window's CSS lacks shared component classes: ${missingShared.join(' ') || '(none found)'}`,
  );
// a utility that is not a single class selector (e.g. "group", "peer", "dark") makes no rule of its own
const missing = utilities.filter((u) => !selectors.has(u));
if (missing.length > 50)
  throw new Error(
    `the desktop window's CSS lacks ${missing.length} utilities, e.g. ${missing.slice(0, 20).join(' ')}`,
  );
console.log(
  'desktop window built ->',
  resolve(ui, 'dist'),
  `(${utilities.length - missing.length}/${utilities.length} utilities, ${classes.length} shared classes checked;`,
  `CSS ${(css.length / 1e6).toFixed(1)} MB)`,
);
