import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs, type FfmpegArgsInput } from '@/lib/ffmpegArgs';

const base: FfmpegArgsInput = {
  mode: 'video-audio',
  extension: 'mp4',
  video: 'copy',
  audio: 'copy',
  videoPath: '/in/video.ts',
  audioFormat: 'mp3',
  audioBitrate: 192,
  output: 'out.mp4',
};

describe('buildFfmpegArgs', () => {
  it('remuxes with stream copy only', () => {
    const a = buildFfmpegArgs(base);
    expect(a).toEqual(expect.arrayContaining(['-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart']));
    expect(a).not.toContain('libx264');
    expect(a.at(-1)).toBe('out.mp4');
  });
  it('merges a separate audio input', () => {
    const a = buildFfmpegArgs({ ...base, audioPath: '/in/audio.ts' });
    expect(a.join(' ')).toContain('-i /in/video.ts -i /in/audio.ts -map 0:v:0 -map 1:a:0');
  });
  it('drops audio for video-only', () => {
    const a = buildFfmpegArgs({ ...base, mode: 'video-only', audio: 'none' });
    expect(a).toContain('-an');
    expect(a).not.toContain('-c:a');
  });
  it.each([
    ['mp3', ['-c:a', 'libmp3lame', '-b:a', '256k']],
    ['wav', ['-c:a', 'pcm_s16le']],
    ['m4a', ['-c:a', 'aac', '-b:a', '256k']],
    ['aac', ['-c:a', 'aac', '-b:a', '256k']],
  ])('audio-only transcode to %s', (ext, codec) => {
    const a = buildFfmpegArgs({
      ...base,
      mode: 'audio-only',
      extension: ext,
      audio: 'transcode',
      audioBitrate: 256,
      output: `out.${ext}`,
    });
    expect(a).toContain('-vn');
    expect(a.join(' ')).toContain((codec as string[]).join(' '));
  });
  it('audio-only copy uses -c:a copy and the separate audio input when present', () => {
    const a = buildFfmpegArgs({
      ...base,
      mode: 'audio-only',
      extension: 'm4a',
      audioPath: '/in/audio.mp4',
      output: 'out.m4a',
    });
    expect(a.join(' ')).toContain('-i /in/audio.mp4 -vn -map 0:a:0 -c:a copy');
  });
  it('re-encodes only the audio when a container requires it', () => {
    const a = buildFfmpegArgs({ ...base, audio: 'transcode' });
    expect(a.join(' ')).toContain('-c:v copy -c:a aac -b:a 192k');
  });
});
