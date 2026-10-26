import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { InlineConfig } from 'vite';

export const ROOT = resolve(import.meta.dirname);
export const SRC = resolve(ROOT, 'src');
export const DIST = resolve(ROOT, 'dist');

export const alias = { '@': SRC };

/** Config shared by all builds. Extension pages must not depend on a dev server or remote code. */
export function baseConfig(): InlineConfig {
  return {
    configFile: false,
    logLevel: 'warn',
    resolve: { alias },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { target: 'chrome120', sourcemap: false, minify: true, reportCompressedSize: false },
  };
}

export function pagesConfig(): InlineConfig {
  const base = baseConfig();
  return {
    ...base,
    root: SRC,
    base: './',
    publicDir: resolve(ROOT, 'public'),
    plugins: [react(), tailwindcss()],
    build: {
      ...base.build,
      outDir: DIST,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          popup: resolve(SRC, 'popup/popup.html'),
          options: resolve(SRC, 'options/options.html'),
          sidepanel: resolve(SRC, 'sidepanel/sidepanel.html'),
          offscreen: resolve(SRC, 'offscreen/offscreen.html'),
        },
      },
    },
  };
}

/** Service worker: a single ES module file. */
export function backgroundConfig(): InlineConfig {
  const base = baseConfig();
  return {
    ...base,
    publicDir: false,
    build: {
      ...base.build,
      outDir: DIST,
      emptyOutDir: false,
      lib: { entry: resolve(SRC, 'background/index.ts'), formats: ['es'], fileName: () => 'background.js' },
    },
  };
}

/** Page hook: a classic script that runs in the page's own world, so it must also be a self-contained IIFE. */
export function hookConfig(): InlineConfig {
  const base = baseConfig();
  return {
    ...base,
    publicDir: false,
    build: {
      ...base.build,
      outDir: DIST,
      emptyOutDir: false,
      lib: {
        entry: resolve(SRC, 'content/hook.ts'),
        formats: ['iife'],
        name: 'vdhHook',
        fileName: () => 'hook.js',
      },
    },
  };
}

/** Content script: classic script, so it must be a self-contained IIFE. */
export function contentConfig(): InlineConfig {
  const base = baseConfig();
  return {
    ...base,
    publicDir: false,
    build: {
      ...base.build,
      outDir: DIST,
      emptyOutDir: false,
      lib: {
        entry: resolve(SRC, 'content/scanner.ts'),
        formats: ['iife'],
        name: 'vdhScanner',
        fileName: () => 'content.js',
      },
    },
  };
}
