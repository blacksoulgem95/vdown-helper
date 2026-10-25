import { describe, expect, it } from 'vitest';
import { audioFitsContainer, bitrateOptions, planOutput, videoFitsContainer, type PlanInput } from '@/lib/compat';

const LIMITS = { maxMemoryMb: 2048, maxEncodeDurationSec: 0 };

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    isHls: false,
    sourceFormat: 'mp4',
    videoFamily: 'h264',
    audioFamily: 'aac',
    hasMuxedAudio: true,
    separateAudio: false,
    hasVideo: true,
    mode: 'video-audio',
    container: 'original',
    audioFormat: 'mp3',
    audioBitrate: 192,
    limits: LIMITS,
    ...over,
  };
}

describe('container compatibility', () => {
  it('checks video and audio families per container', () => {
    expect(videoFitsContainer('h264', 'mp4')).toBe(true);
    expect(videoFitsContainer('vp8', 'mp4')).toBe(false);
    expect(videoFitsContainer('vp9', 'ts')).toBe(false);
    expect(videoFitsContainer('vp8', 'mkv')).toBe(true);
    expect(videoFitsContainer(undefined, 'mp4')).toBe(true);
    expect(audioFitsContainer('vorbis', 'mp4')).toBe(false);
    expect(audioFitsContainer('opus', 'mp4')).toBe(true);
    expect(audioFitsContainer('opus', 'ts')).toBe(false);
  });
});

describe('direct files', () => {
  it('original quality is a native download with no FFmpeg', () => {
    const p = planOutput(input());
    expect(p).toMatchObject({ valid: true, pipeline: 'native', requiresFfmpeg: false, extension: 'mp4' });
  });
  it('same container as source is native', () => {
    expect(planOutput(input({ container: 'mp4' }))).toMatchObject({ pipeline: 'native', requiresFfmpeg: false });
  });
  it('different container uses FFmpeg stream copy when codecs fit', () => {
    const p = planOutput(input({ container: 'mkv' }));
    expect(p).toMatchObject({ valid: true, pipeline: 'file-ffmpeg-copy', requiresFfmpeg: true, video: 'copy', audio: 'copy' });
  });
  it('rejects a container the video codec cannot be copied into (video is never re-encoded)', () => {
    const p = planOutput(input({ sourceFormat: 'webm', videoFamily: 'vp8', audioFamily: 'vorbis', container: 'mp4' }));
    expect(p.valid).toBe(false);
    expect(p.issues).toContain('video-codec-container');
  });
  it('transcodes only the audio when the audio codec does not fit', () => {
    const p = planOutput(input({ sourceFormat: 'webm', videoFamily: 'vp9', audioFamily: 'vorbis', container: 'mp4' }));
    expect(p).toMatchObject({ valid: true, pipeline: 'ffmpeg-transcode', video: 'copy', audio: 'transcode', usesBitrate: true });
  });
  it('video-only from a muxed file needs FFmpeg to drop audio', () => {
    expect(planOutput(input({ mode: 'video-only' }))).toMatchObject({ valid: true, requiresFfmpeg: true, audio: 'none' });
  });
});

describe('audio only', () => {
  it('copies AAC into m4a/aac without transcoding, and offers no bitrate', () => {
    const p = planOutput(input({ mode: 'audio-only', audioFormat: 'm4a', audioFamily: 'aac' }));
    expect(p).toMatchObject({ valid: true, audio: 'copy', usesBitrate: false, extension: 'm4a' });
    expect(bitrateOptions(p)).toEqual([]);
  });
  it('transcodes to mp3 and offers bitrates', () => {
    const p = planOutput(input({ mode: 'audio-only', audioFormat: 'mp3' }));
    expect(p).toMatchObject({ valid: true, audio: 'transcode', pipeline: 'ffmpeg-transcode', usesBitrate: true });
    expect(bitrateOptions(p)).toEqual([128, 192, 256, 320]);
  });
  it('wav is a transcode without a bitrate choice', () => {
    const p = planOutput(input({ mode: 'audio-only', audioFormat: 'wav' }));
    expect(p).toMatchObject({ audio: 'transcode', usesBitrate: false });
  });
  it('an mp3 source requested as mp3 is native', () => {
    const p = planOutput(input({ sourceFormat: 'mp3', hasVideo: false, audioFamily: 'unknown', mode: 'audio-only', audioFormat: 'mp3' }));
    expect(p).toMatchObject({ valid: true, pipeline: 'native', requiresFfmpeg: false });
  });
  it('unknown audio codec is treated as a transcode, never claimed as copy', () => {
    const p = planOutput(input({ isHls: true, audioFamily: undefined, mode: 'audio-only', audioFormat: 'm4a' }));
    expect(p.audio).toBe('transcode');
  });
  it('rejects audio extraction when there is no audio', () => {
    const p = planOutput(input({ isHls: true, hasMuxedAudio: false, mode: 'audio-only' }));
    expect(p.issues).toContain('no-audio-source');
  });
});

describe('HLS', () => {
  const hls = (over: Partial<PlanInput> = {}) => input({ isHls: true, sourceFormat: 'hls', ...over });
  it('MPEG-TS to ts is plain concatenation', () => {
    expect(planOutput(hls({ container: 'ts' }))).toMatchObject({ valid: true, pipeline: 'hls-concat', requiresFfmpeg: false, extension: 'ts' });
  });
  it('original keeps the segment container (ts for MPEG-TS, mp4 for fMP4)', () => {
    expect(planOutput(hls())).toMatchObject({ pipeline: 'hls-concat', extension: 'ts' });
    expect(planOutput(hls({ fragmented: true }))).toMatchObject({ pipeline: 'hls-concat', extension: 'mp4' });
  });
  it('MPEG-TS to mp4 is an FFmpeg stream-copy remux', () => {
    expect(planOutput(hls({ container: 'mp4' }))).toMatchObject({ pipeline: 'hls-ffmpeg-copy', requiresFfmpeg: true, video: 'copy' });
  });
  it('separate audio rendition forces a merge via FFmpeg', () => {
    const p = planOutput(hls({ container: 'mp4', hasMuxedAudio: false, separateAudio: true }));
    expect(p).toMatchObject({ valid: true, requiresFfmpeg: true, video: 'copy', audio: 'copy' });
  });
  it('merge is required even when the user asks for original quality', () => {
    const p = planOutput(hls({ mode: 'original', hasMuxedAudio: false, separateAudio: true, fragmented: true }));
    expect(p.requiresFfmpeg).toBe(true);
    expect(p.extension).toBe('mp4');
  });
  it('refuses live streams and protected streams', () => {
    expect(planOutput(hls({ live: true })).issues).toContain('live-stream');
    expect(planOutput(hls({ protectedStream: true })).issues).toContain('protected');
  });
  it('refuses unsupported sources', () => {
    expect(planOutput(input({ sourceFormat: 'dash' })).issues).toContain('unsupported-source');
    expect(planOutput(input({ sourceFormat: 'blob' })).issues).toContain('unsupported-source');
    expect(planOutput(input({ sourceFormat: 'm3u' })).issues).toContain('unsupported-source');
  });
});

describe('resource limits', () => {
  it('blocks in-memory jobs over the limit but not native downloads', () => {
    const big = 3 * 1024 ** 3;
    expect(planOutput(input({ isHls: true, sourceFormat: 'hls', estimatedBytes: big })).issues).toContain('too-large');
    expect(planOutput(input({ estimatedBytes: big })).valid).toBe(true);
  });
  it('blocks encodes longer than the configured limit', () => {
    const p = planOutput(input({ container: 'mkv', durationSec: 7200, limits: { maxMemoryMb: 2048, maxEncodeDurationSec: 3600 } }));
    expect(p.issues).toContain('too-long-to-encode');
  });
});
