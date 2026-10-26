// Media for the store / site screenshots, made here with ffmpeg (no third-party footage): a fractal "timelapse" as an HLS
// stream in three qualities plus a progressive MP4, a cellular-automaton clip for the embedded player, a soundtrack and
// subtitles. Screenshot tooling only; never shipped with the extension.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ff = (args) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

const SECONDS = 24;
const MARK = '.demo-complete-3';

export function ensureDemoMedia(root) {
  const dir = join(root, 'demo');
  if (existsSync(join(dir, MARK))) return dir;
  for (const d of ['hls/1080', 'hls/720', 'hls/480', 'subs']) mkdirSync(join(dir, d), { recursive: true });

  // A zoom into the Mandelbrot set, rendered small and scaled up (it is smooth, so it scales well).
  const base = join(dir, 'base.mp4');
  ff([
    '-f',
    'lavfi',
    '-i',
    `mandelbrot=size=960x540:rate=25:start_scale=2.5:end_scale=0.0008:end_pts=${SECONDS * 25}:outer=normalized_iteration_count:inner=black:bailout=10:maxiter=4000`,
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='0.08*sin(2*PI*220*t)+0.06*sin(2*PI*277.18*t)+0.05*sin(2*PI*329.63*t)':s=44100",
    '-t',
    String(SECONDS),
    '-vf',
    // grey levels mapped onto the brand: deep navy far out, cyan and magenta along the boundary
    "format=gray,format=rgb24,curves=r='0/0.03 0.42/0.05 0.6/0.02 0.8/1 1/1':g='0/0.04 0.42/0.07 0.6/0.85 0.8/0.17 1/0.95':b='0/0.07 0.42/0.16 0.6/0.95 0.8/0.84 1/1',scale=1920:1080:flags=bicubic",
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-g',
    '50',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    base,
  ]);
  ff(['-i', base, '-c', 'copy', '-movflags', '+faststart', join(dir, 'aurora-1080.mp4')]);
  ff(['-ss', '21', '-i', base, '-frames:v', '1', '-q:v', '3', join(dir, 'poster.jpg')]);

  const variants = [
    { h: 1080, w: 1920, br: 4500 },
    { h: 720, w: 1280, br: 2500 },
    { h: 480, w: 854, br: 1000 },
  ];
  for (const v of variants)
    ff([
      '-i',
      base,
      '-vf',
      `scale=${v.w}:${v.h}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-b:v',
      `${v.br}k`,
      '-g',
      '50',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_filename',
      join(dir, `hls/${v.h}/seg%03d.ts`),
      join(dir, `hls/${v.h}/index.m3u8`),
    ]);
  writeFileSync(
    join(dir, 'hls/master.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n' +
      variants
        .map(
          (v) =>
            `#EXT-X-STREAM-INF:BANDWIDTH=${(v.br + 128) * 1000},RESOLUTION=${v.w}x${v.h},CODECS="avc1.640028,mp4a.40.2"\n${v.h}/index.m3u8\n`,
        )
        .join(''),
  );

  // The embedded player's clip: Conway's game of life in the brand colours.
  ff([
    '-f',
    'lavfi',
    '-i',
    'life=s=320x180:mold=10:r=25:ratio=0.12:death_color=#101522:life_color=#00f5ff,scale=1280:720:flags=neighbor',
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='0.06*sin(2*PI*196*t)*(1+sin(2*PI*0.5*t))':s=44100",
    '-t',
    '42',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '26',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    join(dir, 'behind-the-scenes-720.mp4'),
  ]);

  // The soundtrack, as a separate audio file.
  ff([
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='0.1*sin(2*PI*220*t)*exp(-0.2*mod(t,4))+0.05*sin(2*PI*330*t)':s=44100",
    '-t',
    '96',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '192k',
    join(dir, 'soundtrack.mp3'),
  ]);

  const cue = (lines) =>
    'WEBVTT\n\n' +
    lines
      .map(
        (l, i) =>
          `00:00:${String(i * 6).padStart(2, '0')}.000 --> 00:00:${String(i * 6 + 5).padStart(2, '0')}.000\n${l}\n`,
      )
      .join('\n');
  writeFileSync(
    join(dir, 'subs/en.vtt'),
    cue([
      'A zoom into the Mandelbrot set.',
      'Every frame is computed, not filmed.',
      'Made for this demo.',
      'The end.',
    ]),
  );
  writeFileSync(
    join(dir, 'subs/it.vtt'),
    cue([
      "Uno zoom nell'insieme di Mandelbrot.",
      'Ogni fotogramma è calcolato, non ripreso.',
      'Fatto per questa demo.',
      'Fine.',
    ]),
  );
  writeFileSync(join(dir, MARK), '');
  return dir;
}
