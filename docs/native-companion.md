# Native companion app (design only: not implemented)

> Status: **documented architecture, nothing here is built.** vdown-helper works without it. This document explains
> what a companion would add and how it should be built if you decide to build one.

## Why it could exist

A Chrome extension runs in a sandbox. Three limits cannot be removed from inside it:

| Limit          | Effect today                                                                                                                             | What a native companion changes                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Browser memory | FFmpeg.wasm keeps its output in memory (default cap 2 GB, configurable). Larger conversions are refused with a message that points here. | A native `ffmpeg` writes straight to disk: no practical size cap. |
| Codecs / speed | Video is only ever stream-copied; audio can be transcoded. wasm FFmpeg is single-threaded and several times slower than native.          | Full codec support, hardware acceleration, multi-threading.       |
| Disk access    | Chrome decides the download folder; the extension can only pick a sub-folder.                                                            | The companion can write wherever the user configured.             |

Plain downloads, segment concatenation to TS/fMP4 (staged on disk through OPFS) and stream copies of normal-sized
videos already work without a companion.

## Architecture

```
┌──────────────────────┐   chrome.runtime.connectNative   ┌────────────────────────┐
│ vdown-helper         │ ───────── stdio JSON ──────────▶ │ vdown-companion (host) │
│ service worker       │ ◀──────────────────────────────  │  - validates requests  │
└──────────────────────┘      length-prefixed frames       │  - spawns ffmpeg       │
          ▲                                                │  - writes to disk      │
          │ job progress (same JobProgress type)           └────────────────────────┘
```

- Chrome Native Messaging: a host manifest (`com.vdownhelper.companion.json`) registered per OS lists the host
  binary path and `allowed_origins: ["chrome-extension://<extension-id>/"]`. Only this extension can talk to it.
- The extension would declare the **`nativeMessaging`** permission as _optional_ and request it only when the user
  enables the companion in Settings.
- Protocol: 4-byte length + UTF-8 JSON, versioned (`{ "v": 1, "type": ... }`).

### Messages (proposed)

| Direction  | Type       | Payload                                                                                                               |
| ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| ext → host | `hello`    | `{ v, extensionVersion }` → host replies `{ v, hostVersion, ffmpeg: { version, encoders[] } }`                        |
| ext → host | `run-job`  | `DownloadRequest` + resolved plan + list of playlist/segment URLs the user already authorised + `credentialedOrigins` |
| host → ext | `progress` | `JobProgress` (same shape the extension already uses)                                                                 |
| host → ext | `done`     | `{ path, bytes }`                                                                                                     |
| host → ext | `error`    | `{ code, message }` (same `JobErrorCode` set)                                                                         |
| ext → host | `cancel`   | `{ jobId }`                                                                                                           |

The extension would keep the queue, stages and UI exactly as today; the companion is just another pipeline next to
`native` and the offscreen document (`pipeline: 'companion'`).

## Security model

- The host never accepts arbitrary commands: it builds the `ffmpeg` argument vector itself from a closed set of
  operations (copy / merge / extract audio / transcode audio), mirroring `src/lib/ffmpegArgs.ts`. No shell is used.
- Output paths are validated: inside a user-configured root, file names sanitised with the same rules as
  `sanitizeFilename`.
- The host fetches only URLs on `http(s)` and refuses `file:`, `ftp:` and private-network targets unless the user
  explicitly allows them. It never follows redirects to another scheme.
- No network access beyond fetching the media URLs the user chose; no telemetry; no auto-update from the network.
- DRM and SAMPLE-AES streams are refused by the host as well. The companion is **not** a way around protections.
- Distribution: signed, per-OS installer; the extension shows the exact install steps and verifies the `hello`
  handshake before enabling any companion feature.

## Install flow (proposed)

1. Settings → _Companion app_ → "Learn more" (links to this page).
2. User installs the signed host package. The installer writes the native-messaging manifest.
3. User enables the optional `nativeMessaging` permission in Settings.
4. Extension sends `hello`; Settings shows the detected `ffmpeg` version and encoders.
5. Jobs that exceed the in-browser limits show **"Run with companion"** instead of a refusal.

## Why it is optional and not built here

It needs per-OS installers, code signing, a release process and a security review: that is a product decision, not
something an extension build can include silently. Until then the extension tells users honestly why a job was
refused and what their options are (raise the memory cap, choose TS/original, or download directly).
