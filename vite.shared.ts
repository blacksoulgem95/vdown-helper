import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { InlineConfig, Plugin } from 'vite';

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

/**
 * FFmpeg.wasm's worker falls back to a core on unpkg.com when `load()` is given no `coreURL`. The extension always
 * passes its bundled core (`vendor/ffmpeg`), but the Web Store refuses a script that names remote code at all, so the
 * default is replaced by the bundled copy at build time. The build fails if the library changes and the replacement no
 * longer applies (`check:dist` also rejects any remote address in the shipped scripts).
 */
function bundledFfmpegCore(): Plugin {
  const constants = /@ffmpeg[\\/]ffmpeg[\\/]dist[\\/]esm[\\/]const\.js$/;
  const remote = /export const CORE_URL = `https:\/\/unpkg\.com\/[^`]*`;/;
  return {
    name: 'vdh-bundled-ffmpeg-core',
    transform(code, id) {
      if (!constants.test(id)) return null;
      if (!remote.test(code))
        this.error('@ffmpeg/ffmpeg changed: its default core address was not found in const.js');
      return code.replace(remote, "export const CORE_URL = '/vendor/ffmpeg/ffmpeg-core.js';");
    },
  };
}

export function pagesConfig(): InlineConfig {
  const base = baseConfig();
  return {
    ...base,
    root: SRC,
    base: './',
    publicDir: resolve(ROOT, 'public'),
    plugins: [react(), tailwindcss(), bundledFfmpegCore()],
    // the FFmpeg.wasm worker is a separate bundle with its own plugins
    worker: { plugins: () => [bundledFfmpegCore()] },
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
