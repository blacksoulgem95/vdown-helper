---
id: VDH-040
title: Live and event stream recording
status: done
priority: P1
area: background
depends_on: [VDH-034]
---

# VDH-040: Live and event stream recording

## Description

Record HLS live/event and DASH dynamic streams by refreshing the manifest and appending new segments until Stop, stream end or a limit (default 2 h / 4 GB). New "recording" stage and "stop" action; output TS, or MP4 within the memory limit.

## Acceptance criteria

- [x] Live HLS recording in E2E stops with Stop and with the limit, output decodable (E2E: Stop from the queue; a 1-minute limit that stops the recording at 60 s of media; ends with the stream too; ffprobe + full decode)
- [x] DASH dynamic recording works (E2E: dynamic manifest with a clock-based `SegmentTemplate`, separate video and audio, ends when the manifest turns static)
- [x] Duplicate/missed segments are handled by sequence (unit: overlapping windows are written once; a jump in the media sequence and a 404 segment are counted as gaps; E2E: a dropped segment gives a completed recording with "1 segment(s) were no longer available")
- [x] Stop saves the file (is not cancel); cancel still discards (E2E for both)
- [x] Limits are configurable in Settings (Options -> Recording: longest recording, largest recording; shared with MediaStream recording)

## Notes

- Engine: `offscreen/live.ts` `recordLiveTrack` looks at the stream again and again (HLS media playlist or one DASH representation of a dynamic manifest), appends every segment it has not
  recorded yet to one staged file in order (the segment engine of `offscreen/hls.ts`, `writeSegments`, now appends in batches and can tolerate segments that are gone), and ends on Stop, the
  end of the stream (ENDLIST / the manifest turning static), a limit, or a stream that stops moving (60 s without new media, or 5 failed looks in a row, after something was recorded).
- A stream with a separate audio playlist is recorded as two files and joined with a stream copy that keeps their real offset (`-copyts -avoid_negative_ts make_zero`): E2E checks that an audio
  playlist that begins one segment later ends up 2 s after the video in the file.
- Output: MP4 (M4A for audio-only) by stream copy when the recording is at most half the memory limit; otherwise a single-track recording is saved as the stream delivered it (TS or fragmented
  MP4), and a two-track one is refused with a message to raise the memory limit. If the copy fails for a single track, the raw recording is kept.
- DASH dynamic: the manifest carries `availabilityStartTime`, `minimumUpdatePeriod` and `timeShiftBufferDepth`; `expandSegments` takes a clock and lists the complete segments inside the window
  (numbers) or the timeline (open-ended `r=-1` up to now). The last period is the main one. Multi-period live streams record the period that is on when each look happens.
- UI: a live or event stream is now `downloadable` with detail `live-recordable`; its card offers RECORD (never DOWNLOAD), the queue shows RECORDING with elapsed time and size and a
  "Stop and save" button; a job action `stop` (offscreen command `stop-job`) is different from cancel. The background only accepts `liveRecord` when its own inspection says the stream is live.
- Honest limits: recording starts from what the stream lists now (for an EVENT playlist that is everything since the start, up to the limits); no DRM (refused as before); a gap leaves a hole in
  the timeline (the player freezes for that long) and is reported, never hidden; DASH live with `SegmentTimeline` S@r=-1 or period-relative `availabilityStartTime` tricks beyond the common cases is
  not covered; real third-party live streams were not tried (only local fixtures).
