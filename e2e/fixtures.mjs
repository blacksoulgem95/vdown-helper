// Generates deterministic media fixtures with the system ffmpeg (test tooling only, never shipped).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';

const ff = (args) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

export function ensureFixtures(dir) {
  if (existsSync(join(dir, '.complete4'))) return;
  mkdirSync(dir, { recursive: true });
  for (const d of [
    'media',
    'hls/v360',
    'hls/v180',
    'hls-sep/video',
    'hls-sep/audio',
    'hls-aes',
    'hls-live',
    'hls-drm',
    'lists',
    'dash',
    'flaky',
    'big',
    'hls-long',
    'hls-aes-fmp4',
    'hls-range',
  ]) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  const sample = join(dir, 'media/sample.mp4');
  // 6 s, 25 fps, keyframe every 2 s so HLS segments split cleanly.
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100',
    '-t',
    '6',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-g',
    '50',
    '-keyint_min',
    '50',
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    sample,
  ]);

  const hls = (input, outDir, extra, name = 'index.m3u8') =>
    ff([
      '-i',
      input,
      ...extra,
      '-f',
      'hls',
      '-hls_time',
      '2',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_filename',
      join(outDir, 'seg%d.ts'),
      join(outDir, name),
    ]);

  hls(sample, join(dir, 'hls/v360'), ['-c', 'copy']);
  hls(sample, join(dir, 'hls/v180'), [
    '-vf',
    'scale=320:180',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-g',
    '50',
    '-keyint_min',
    '50',
    '-sc_threshold',
    '0',
    '-c:a',
    'copy',
  ]);
  writeFileSync(
    join(dir, 'hls/master.m3u8'),
    `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=400000,AVERAGE-BANDWIDTH=350000,RESOLUTION=640x360,FRAME-RATE=25,CODECS="avc1.64001e,mp4a.40.2"
v360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180,FRAME-RATE=25,CODECS="avc1.42c00d,mp4a.40.2"
v180/index.m3u8
`,
  );

  // Separate audio rendition (video-only variant + audio group): needs a merge.
  hls(sample, join(dir, 'hls-sep/video'), ['-an', '-c:v', 'copy']);
  hls(sample, join(dir, 'hls-sep/audio'), ['-vn', '-c:a', 'copy']);
  writeFileSync(
    join(dir, 'hls-sep/master.m3u8'),
    `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=640x360,FRAME-RATE=25,CODECS="avc1.64001e",AUDIO="aud"
video/index.m3u8
`,
  );

  // AES-128 (IV derived from the media sequence number).
  const key = randomBytes(16);
  writeFileSync(join(dir, 'hls-aes/key.bin'), key);
  writeFileSync(join(dir, 'hls-aes/keyinfo.txt'), `key.bin\n${join(dir, 'hls-aes/key.bin')}\n`);
  ff([
    '-i',
    sample,
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_playlist_type',
    'vod',
    '-hls_key_info_file',
    join(dir, 'hls-aes/keyinfo.txt'),
    '-hls_segment_filename',
    join(dir, 'hls-aes/seg%d.ts'),
    join(dir, 'hls-aes/index.m3u8'),
  ]);

  // Live (no ENDLIST) and SAMPLE-AES (protected) variants reusing real segments.
  const v360 = readFileSync(join(dir, 'hls/v360/index.m3u8'), 'utf8');
  writeFileSync(
    join(dir, 'hls-live/index.m3u8'),
    v360
      .replace('#EXT-X-ENDLIST', '')
      .replace(/seg(\d+)\.ts/g, '../hls/v360/seg$1.ts')
      .replace('#EXT-X-PLAYLIST-TYPE:VOD\n', ''),
  );
  writeFileSync(
    join(dir, 'hls-drm/index.m3u8'),
    v360
      .replace(
        '#EXT-X-TARGETDURATION',
        '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXT-X-TARGETDURATION',
      )
      .replace(/seg(\d+)\.ts/g, '../hls/v360/seg$1.ts'),
  );

  // Not HLS.
  writeFileSync(
    join(dir, 'lists/playlist.m3u'),
    '#EXTM3U\n#EXTINF:215,Artist - Song\nhttp://127.0.0.1/song.mp3\n',
  );
  writeFileSync(
    join(dir, 'dash/manifest.mpd'),
    '<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"></MPD>\n',
  );

  // "Flaky": a valid playlist whose segments 404 until the server is told to enable them (retry test).
  writeFileSync(
    join(dir, 'flaky/index.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\nseg0.ts\n#EXTINF:2.0,\nseg1.ts\n#EXT-X-ENDLIST\n',
  );
  // 5 minutes of tiny video + audio, 10 s segments: long enough for FFmpeg to report progress while encoding.
  ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:sample_rate=44100',
    '-t',
    '300',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-g',
    '25',
    '-keyint_min',
    '25',
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-b:a',
    '32k',
    '-f',
    'hls',
    '-hls_time',
    '10',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    join(dir, 'hls-long/seg%d.ts'),
    join(dir, 'hls-long/index.m3u8'),
  ]);
  writeFileSync(
    join(dir, 'hls-long/master.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=120000,RESOLUTION=160x90,FRAME-RATE=5,CODECS="avc1.42c00b,mp4a.40.2"\nindex.m3u8\n',
  );

  // AES-128 encrypted fMP4. ffmpeg cannot write this combination, so a clear fMP4 HLS is generated and then
  // encrypted here (CBC + PKCS7, explicit IV). The init section is encrypted too (RFC 8216 4.3.2.5).
  const clear = join(dir, 'hls-aes-fmp4');
  ff([
    '-i',
    sample,
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    join(clear, 'seg%d.m4s'),
    join(clear, 'index.m3u8'),
  ]);
  const k2 = randomBytes(16);
  const iv = Buffer.alloc(16);
  iv[15] = 1;
  const encrypt = (file) => {
    const c = createCipheriv('aes-128-cbc', k2, iv);
    writeFileSync(file, Buffer.concat([c.update(readFileSync(file)), c.final()]));
  };
  writeFileSync(join(clear, 'key.bin'), k2);
  for (const f of readdirSync(clear)) if (f === 'init.mp4' || f.endsWith('.m4s')) encrypt(join(clear, f));
  const m3u8 = readFileSync(join(clear, 'index.m3u8'), 'utf8').replace(
    '#EXT-X-MAP',
    `#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${iv.toString('hex')}\n#EXT-X-MAP`,
  );
  writeFileSync(join(clear, 'index.m3u8'), m3u8);

  // Byte-range playlist: all segments live in ONE file (EXT-X-BYTERANGE).
  ff([
    '-i',
    sample,
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_playlist_type',
    'vod',
    '-hls_flags',
    'single_file',
    '-hls_segment_filename',
    join(dir, 'hls-range/media.ts'),
    join(dir, 'hls-range/index.m3u8'),
  ]);

  mkdirSync(join(dir, 'stall'), { recursive: true });
  writeFileSync(
    join(dir, 'stall/index.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n/__stall/seg.ts\n#EXT-X-ENDLIST\n',
  );

  // Two 70 MB "segments" (zeros): the playlist is valid, the data is not media. Used to trip the memory guard.
  const chunk = Buffer.alloc(70 * 1024 * 1024);
  writeFileSync(join(dir, 'big/seg0.ts'), chunk);
  writeFileSync(join(dir, 'big/seg1.ts'), chunk);
  writeFileSync(
    join(dir, 'big/index.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nseg0.ts\n#EXTINF:10.0,\nseg1.ts\n#EXT-X-ENDLIST\n',
  );
  writeFileSync(join(dir, '.complete4'), 'ok');
}
