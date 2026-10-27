import { describe, expect, it } from 'vitest';
import {
  audioFitsContainer,
  bitrateOptions,
  planOutput,
  videoFitsContainer,
  type PlanInput,
} from '@/lib/compat';

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
    expect(planOutput(input({ container: 'mp4' }))).toMatchObject({
      pipeline: 'native',
      requiresFfmpeg: false,
    });
  });
  it('different container uses FFmpeg stream copy when codecs fit', () => {
    const p = planOutput(input({ container: 'mkv' }));
    expect(p).toMatchObject({
      valid: true,
      pipeline: 'file-ffmpeg-copy',
      requiresFfmpeg: true,
      video: 'copy',
      audio: 'copy',
    });
  });
  it('rejects a container the video codec cannot be copied into (video is never re-encoded)', () => {
    const p = planOutput(
      input({ sourceFormat: 'webm', videoFamily: 'vp8', audioFamily: 'vorbis', container: 'mp4' }),
    );
    expect(p.valid).toBe(false);
    expect(p.issues).toContain('video-codec-container');
  });
  it('transcodes only the audio when the audio codec does not fit', () => {
    const p = planOutput(
      input({ sourceFormat: 'webm', videoFamily: 'vp9', audioFamily: 'vorbis', container: 'mp4' }),
    );
    expect(p).toMatchObject({
      valid: true,
      pipeline: 'ffmpeg-transcode',
      video: 'copy',
      audio: 'transcode',
      usesBitrate: true,
    });
  });
  it('video-only from a muxed file needs FFmpeg to drop audio', () => {
    expect(planOutput(input({ mode: 'video-only' }))).toMatchObject({
      valid: true,
      requiresFfmpeg: true,
      audio: 'none',
    });
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
    expect(p).toMatchObject({
      valid: true,
      audio: 'transcode',
      pipeline: 'ffmpeg-transcode',
      usesBitrate: true,
    });
    expect(bitrateOptions(p)).toEqual([128, 192, 256, 320]);
  });
  it('wav is a transcode without a bitrate choice', () => {
    const p = planOutput(input({ mode: 'audio-only', audioFormat: 'wav' }));
    expect(p).toMatchObject({ audio: 'transcode', usesBitrate: false });
  });
  it('an mp3 source requested as mp3 is native', () => {
    const p = planOutput(
      input({
        sourceFormat: 'mp3',
        hasVideo: false,
        audioFamily: 'unknown',
        mode: 'audio-only',
        audioFormat: 'mp3',
      }),
    );
    expect(p).toMatchObject({ valid: true, pipeline: 'native', requiresFfmpeg: false });
  });
  it('unknown audio codec is treated as a transcode, never claimed as copy', () => {
    const p = planOutput(
      input({ isHls: true, audioFamily: undefined, mode: 'audio-only', audioFormat: 'm4a' }),
    );
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
    expect(planOutput(hls({ container: 'ts' }))).toMatchObject({
      valid: true,
      pipeline: 'hls-concat',
      requiresFfmpeg: false,
      extension: 'ts',
    });
  });
  it('original keeps the segment container (ts for MPEG-TS, mp4 for fMP4)', () => {
    expect(planOutput(hls())).toMatchObject({ pipeline: 'hls-concat', extension: 'ts' });
    expect(planOutput(hls({ fragmented: true }))).toMatchObject({ pipeline: 'hls-concat', extension: 'mp4' });
  });
  it('MPEG-TS to mp4 is an FFmpeg stream-copy remux', () => {
    expect(planOutput(hls({ container: 'mp4' }))).toMatchObject({
      pipeline: 'hls-ffmpeg-copy',
      requiresFfmpeg: true,
      video: 'copy',
    });
  });
  it('separate audio rendition forces a merge via FFmpeg', () => {
    const p = planOutput(hls({ container: 'mp4', hasMuxedAudio: false, separateAudio: true }));
    expect(p).toMatchObject({ valid: true, requiresFfmpeg: true, video: 'copy', audio: 'copy' });
  });
  it('merge is required even when the user asks for original quality', () => {
    const p = planOutput(
      hls({ mode: 'original', hasMuxedAudio: false, separateAudio: true, fragmented: true }),
    );
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
  it('warns (never blocks) when one stream may not fit in memory to convert; blocks only joining two tracks', () => {
    const big = 3 * 1024 ** 3;
    const hls = { isHls: true, sourceFormat: 'hls' as const, estimatedBytes: big };
    // one stream: downloaded to disk in full, so a conversion that cannot fit falls back to saving it as it is
    const mp4 = planOutput(input({ ...hls, container: 'mp4' }));
    expect(mp4.valid).toBe(true);
    expect(mp4.warnings).toEqual(['large-for-memory']);
    // separate video and audio can only become one file in FFmpeg's memory
    expect(planOutput(input({ ...hls, container: 'mp4', separateAudio: true })).issues).toContain(
      'too-large',
    );
    // disk-backed paths never warn
    expect(planOutput(input({ ...hls, container: 'ts' })).warnings).toBeUndefined();
    expect(planOutput(input({ estimatedBytes: big })).valid).toBe(true);
  });
  it('blocks encodes longer than the configured limit', () => {
    const p = planOutput(
      input({
        container: 'mkv',
        durationSec: 7200,
        limits: { maxMemoryMb: 2048, maxEncodeDurationSec: 3600 },
      }),
    );
    expect(p.issues).toContain('too-long-to-encode');
  });
});

describe('"Original quality" mode', () => {
  it('honours an explicit container as a stream-copy remux', () => {
    const p = planOutput(input({ mode: 'original', container: 'mkv' }));
    expect(p).toMatchObject({ valid: true, pipeline: 'file-ffmpeg-copy', extension: 'mkv', audio: 'copy' });
  });
  it('never re-encodes: an audio codec that does not fit the container is refused, not converted', () => {
    const p = planOutput(
      input({
        mode: 'original',
        sourceFormat: 'webm',
        videoFamily: 'vp9',
        audioFamily: 'vorbis',
        container: 'mp4',
      }),
    );
    expect(p.valid).toBe(false);
    expect(p.issues).toContain('audio-codec-container');
    // ...whereas Video + Audio is allowed to convert just the audio.
    expect(
      planOutput(
        input({
          mode: 'video-audio',
          sourceFormat: 'webm',
          videoFamily: 'vp9',
          audioFamily: 'vorbis',
          container: 'mp4',
        }),
      ).valid,
    ).toBe(true);
  });
});

describe('legacy and extra source formats', () => {
  const plan = (over: Partial<PlanInput>) =>
    planOutput(input({ videoFamily: undefined, audioFamily: undefined, ...over }));

  it('keeps any of them as they are: a native download with the format as extension', () => {
    for (const f of ['flv', 'avi', 'wmv', 'asf', '3gp', 'mpg'] as const) {
      expect(plan({ sourceFormat: f })).toMatchObject({
        valid: true,
        pipeline: 'native',
        extension: f,
        requiresFfmpeg: false,
      });
    }
  });

  it('only copies into containers that can take the format, and never offers a re-encode', () => {
    const targets = (f: PlanInput['sourceFormat']) =>
      (['mp4', 'mkv', 'ts'] as const).filter((c) => plan({ sourceFormat: f, container: c }).valid);
    expect(targets('flv')).toEqual(['mp4', 'mkv', 'ts']);
    expect(targets('avi')).toEqual(['mkv']);
    expect(targets('wmv')).toEqual(['mkv']);
    expect(targets('asf')).toEqual(['mkv']);
    expect(targets('mpg')).toEqual(['mkv', 'ts']);
    expect(targets('3gp')).toEqual(['mp4', 'mkv']);
    const refused = plan({ sourceFormat: 'wmv', container: 'mp4' });
    expect(refused).toMatchObject({ valid: false, issues: ['video-codec-container'] });
    // a video-only copy follows the same rule
    expect(plan({ sourceFormat: 'avi', mode: 'video-only', container: 'mp4' }).issues).toEqual([
      'video-codec-container',
    ]);
    const mkv = plan({ sourceFormat: 'avi', container: 'mkv' });
    expect(mkv).toMatchObject({ valid: true, pipeline: 'file-ffmpeg-copy', video: 'copy', extension: 'mkv' });
  });

  it('sources that are not restricted keep working as before', () => {
    expect(plan({ sourceFormat: 'webm', container: 'mp4' }).valid).toBe(true);
    expect(plan({ sourceFormat: 'mov', container: 'mkv' }).valid).toBe(true);
  });

  it('an audio file saved as it is works with the default settings (it used to be refused as "no video")', () => {
    for (const f of ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac', 'aiff', 'wma', 'opus'] as const) {
      expect(plan({ sourceFormat: f, hasVideo: false, mode: 'original' })).toMatchObject({
        valid: true,
        pipeline: 'native',
        audio: 'copy',
        extension: f,
        requiresFfmpeg: false,
      });
    }
    // an audio-only HLS rendition is joined without FFmpeg
    expect(
      plan({ sourceFormat: 'hls', isHls: true, hasVideo: false, hasMuxedAudio: true, mode: 'original' }),
    ).toMatchObject({ valid: true, pipeline: 'hls-concat', extension: 'ts' });
    expect(
      plan({
        sourceFormat: 'hls',
        isHls: true,
        fragmented: true,
        hasVideo: false,
        hasMuxedAudio: true,
        mode: 'original',
      }),
    ).toMatchObject({ valid: true, pipeline: 'hls-concat', extension: 'm4a' });
  });

  it('an audio file saved as it is works with the default settings (it used to be refused as "no video")', () => {
    for (const f of ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac', 'aiff', 'wma', 'opus'] as const) {
      expect(plan({ sourceFormat: f, hasVideo: false, mode: 'original' })).toMatchObject({
        valid: true,
        pipeline: 'native',
        audio: 'copy',
        extension: f,
        requiresFfmpeg: false,
      });
    }
    // an audio-only HLS rendition is joined without FFmpeg
    expect(
      plan({ sourceFormat: 'hls', isHls: true, hasVideo: false, hasMuxedAudio: true, mode: 'original' }),
    ).toMatchObject({ valid: true, pipeline: 'hls-concat', extension: 'ts' });
    expect(
      plan({
        sourceFormat: 'hls',
        isHls: true,
        fragmented: true,
        hasVideo: false,
        hasMuxedAudio: true,
        mode: 'original',
      }),
    ).toMatchObject({ valid: true, pipeline: 'hls-concat', extension: 'm4a' });
  });

  it('audio formats are audio files: extracted and converted, with real encodes only for audio', () => {
    for (const f of ['aiff', 'wma', 'opus'] as const) {
      const mp3 = plan({ sourceFormat: f, hasVideo: false, mode: 'audio-only', audioFormat: 'mp3' });
      expect(mp3).toMatchObject({
        valid: true,
        pipeline: 'ffmpeg-transcode',
        audio: 'transcode',
        extension: 'mp3',
      });
      // video-only of an audio file is meaningless
      expect(plan({ sourceFormat: f, hasVideo: false, mode: 'video-only' }).issues).toEqual([
        'no-video-source',
      ]);
    }
  });
});
