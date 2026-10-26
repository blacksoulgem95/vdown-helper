---
id: VDH-039
title: MediaStream recording
status: done
priority: P1
area: content
depends_on: [VDH-038]
---

# VDH-039: MediaStream recording

## Description

Record video.srcObject MediaStreams (camera, screen share, WebRTC, canvas) with MediaRecorder: WebM, or MP4 where Chrome supports it; Stop button; audio-only through the existing audio pipeline.

## Acceptance criteria

- [x] MediaStream sources are detected and offer Record/Stop (E2E: a canvas + WebAudio stream; Record in the popup, Stop in the queue and in the page banner)
- [x] Output plays and is decodable (E2E with a canvas stream: video+audio, video only, audio only; ffprobe and a full decode)
- [x] Recording indicator is visible; limits are enforced (E2E: banner with elapsed time and size; a 1-minute limit really stops the recording and the file is saved; the size limit is covered by a unit test of the page controller with a fake recorder, because the smallest size limit a user can set is 64 MB)
- [x] Protected streams are refused (a MediaStream itself cannot carry DRM; an element with `mediaKeys` is never offered, and the background refuses a record request for anything the scan did not offer as a stream: unit and E2E)

## Notes

- Detection (`content/scanner.ts`, `content/capture.ts` `describeStream`): a `<video>`/`<audio>` whose `srcObject` is a MediaStream with a live track is listed as a `blob` resource
  with `held.kind = 'stream'` and a label instead of an address; no page hook is needed. Ended streams and elements with `mediaKeys` are not offered.
- Recording (`startRecord`): a `MediaRecorder` on the page's own stream (read only: the page keeps playing it). The recorder's 1-second pieces are streamed to the offscreen document over
  the acknowledged port (`cbegin{mime}` / `cchunk` / `cend`), staged on disk, then tidied with an FFmpeg **stream copy** (duration and index; WebM from MediaRecorder has neither). If
  the tidy-up fails or the file is larger than half the memory limit, the file is kept as the recorder wrote it.
- New job stage `recording` (the job is "recording" from the moment the page starts) and job action `stop` ("Stop and save", different from cancel, which discards). The same stage and action
  are what VDH-040 will use for live streams.
- Limits (Options -> Recording): longest recording (default 120 min), largest recording (default 4096 MB), enforced by the page, which then stops gracefully and the file is saved; the
  offscreen document has a hard stop 5 % above. Format: WebM, or MP4 only where this Chrome records it natively (otherwise WebM).
- Closing or navigating away from the tab keeps what had arrived (the file is shorter; nothing before that point is lost).
- Found while verifying: the recorder's type contains a comma (`codecs=vp9,opus`) which broke the base64 extraction of `FileReader.readAsDataURL` output; it now takes everything after the last comma.
  Also: a request carrying `capture`/`record` for a source that is not a page-held label was not refused; it is now.
- Not verified here: the MP4 recording path (Chromium for Testing has no H.264 encoder) -> VDH-028. Audio-only streams are saved as WebM/M4A audio; converting them to MP3 etc. through the audio pipeline
  is not offered (the original recording is kept).
- A stream whose audio is silent because the page's AudioContext is not running produces no data until it runs (a MediaRecorder property); the banner shows 0.0 MB in that case.
