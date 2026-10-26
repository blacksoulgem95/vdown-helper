# Third-party notices

vdown-helper's own source code is MIT licensed (see `LICENSE`). The built extension bundles the components below.
Licence identifiers come from each package's `package.json` as installed; they were **not** independently audited
against the upstream source, so check them before redistributing.

| Component                                                       | Version | Declared licence     | Where it ends up                                     |
| --------------------------------------------------------------- | ------- | -------------------- | ---------------------------------------------------- |
| `@ffmpeg/core` (FFmpeg compiled to WebAssembly)                 | 0.12.10 | **GPL-2.0-or-later** | `dist/vendor/ffmpeg/ffmpeg-core.{js,wasm}` (≈ 31 MB) |
| `@ffmpeg/ffmpeg`                                                | 0.12.15 | MIT                  | offscreen bundle + worker                            |
| fflate (ZIP writer)                                             | 0.8.3   | MIT                  | offscreen bundle                                     |
| React / React DOM                                               | 19.3.1  | MIT                  | popup, options, side panel                           |
| lucide-react (icons)                                            | 1.61.0  | ISC                  | popup, options, side panel                           |
| Inter (variable, latin subset) via `@fontsource-variable/inter` | 5.3.0   | SIL OFL-1.1          | `dist/assets/*.woff2`                                |
| JetBrains Mono (latin 400/700) via `@fontsource/jetbrains-mono` | 5.3.0   | SIL OFL-1.1          | `dist/assets/*.woff2`                                |

## About the GPL FFmpeg core

- The FFmpeg.wasm core is a separate program (a WebAssembly binary plus its JavaScript loader). vdown-helper loads it
  from the extension package and talks to it only through the `@ffmpeg/ffmpeg` message API in a Web Worker. It is
  never fetched from a CDN and never modified.
- The core's declared licence is GPL-2.0-or-later. Distributing a package that contains it carries GPL obligations
  for that component (notably making its corresponding source available). The upstream source for this exact
  version is published by the ffmpegwasm project; the FFmpeg, x264 and lame sources it was built from are available
  from their own projects.
- **Whether shipping the combined extension (MIT application code + GPL component) in a store raises further
  licence questions is a legal decision for the project owner.** If that is a concern, a build without the core is
  possible: delete `dist/vendor/ffmpeg`, and merging/remuxing/audio conversion are then unavailable while direct
  downloads and plain TS/fMP4 concatenation keep working. Jobs that need FFmpeg then fail with a "Conversion failed" error.
