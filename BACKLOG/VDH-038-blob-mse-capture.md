---
id: VDH-038
title: Blob files and MSE capture
status: done
priority: P0
area: content
depends_on: [VDH-033]
---

# VDH-038: Blob files and MSE capture

## Description

Read real Blob sources from the page. For MSE players, first discover the real manifest via the hook; when none exists, record what the player appends (fast capture with a visible banner, or real-time), mux it and save. EME/protected playback is refused.

## Acceptance criteria

- [x] Real Blob URLs download correctly (E2E: typed and untyped blobs, a 9 MiB blob over several chunks, a URL revoked after listing)
- [x] hls.js and dash.js players inside iframes are resolved through manifest discovery (E2E: the real hls.js 1.x and dash.js 5.x players, in a cross-origin frame; manifest found by the hook, downloaded to a decodable VP9+Opus MP4; the MSE video is listed too)
- [x] Recording fallback produces a decodable file (fast and real-time) (E2E: genuine MSE playback with VP9/Opus; ffprobe + full decode of both results)
- [x] A visible, cancellable banner shows while the page is manipulated, and playback state is restored (E2E: cancel from the banner button and from the queue; muted/rate/paused restored after success and after cancel)
- [x] EME-protected video is refused and never recorded (E2E: no capture button; forged request refused by the background)
- [x] A resolution switch during capture yields parts, never a re-encode (E2E: 320 and 640 wide parts, streams copied)

## Notes

### Stage 1 (done): real blob files

- The synchronous scan still never reports `blob:` sources; `scanAsync()` reads each one with `fetch(blobUrl)` (2.5 s limit), keeps the **Blob object**
  (so a page that revokes the URL afterwards cannot take the data away from a download already offered), recognises untyped blobs from their first
  bytes (`lib/sniff.ts`; Chrome answers fetch() of an untyped Blob with `text/plain`, which is not trusted) and lists the result like any file/image/
  document/archive/asset with its real size. What cannot be read (MediaSource URLs, URLs revoked before the scan, unknown content) stays counted in
  `notes.blobSources`.
- Bytes travel over the same acknowledged port as `data:` (VDH-036), now in 4 MiB chunks and streamed from the Blob; a blob is capped at 4 GiB (a `data:` URL at
  32 MB); FFmpeg conversions are still bounded by the memory limit.

### Stage 2 (done): MSE capture

- The hook (`content/hook.ts`, MAIN world, opt-in) remembers which MediaSource a `blob:` URL stands for and each SourceBuffer's latest init segment; it records
  appended data only while the isolated-world controller (`content/capture.ts`) has armed one MediaSource at the user's request. The controller flushes the
  buffers, seeks to 0, mutes, raises the rate (fast = 16x) or keeps 1x (real time), relays chunks over an acknowledged port to the offscreen document and puts
  the video back. A banner (closed shadow root) shows progress and a Cancel button.
- Offscreen (`lib/mse.ts`, `lib/mseParts.ts`, `offscreen/capture.ts`): chunks are classified, de-duplicated, split into parts when the video init changes (a
  quality switch), audio is placed by time window, and each part is muxed with FFmpeg stream copy (mp4/webm/mkv/m4a/mka). Extra parts become child jobs.
- Found while verifying: cancelling from the page banner used to end the job as `failed`; the offscreen side now treats the page's `cancelled` report as a
  cancellation.
- Honest limits: only the quality the player chose is captured; playback is needed (fast capture still plays the whole clip at up to 16x); EME playback and live
  MediaSources (non-finite duration) are refused (live recording is VDH-040); the real players were tested with VP9/Opus because Chromium for Testing has no
  proprietary codecs, so H.264/AAC MSE capture relies on the parsers verified against real ffmpeg fMP4 output (`tests/mse*.test.ts`).
