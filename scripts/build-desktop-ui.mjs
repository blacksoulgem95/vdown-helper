// Builds the desktop app's window (desktop/ui) into desktop/ui/dist, which the Tauri app embeds.
// It shares the extension's components, theme, fonts, catalogs and Rust core (src/, _locales/, src/lib/core.ts).
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const { baseConfig } = await import(resolve(root, 'vite.shared.ts'));
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
console.log('desktop window built ->', resolve(ui, 'dist'));
