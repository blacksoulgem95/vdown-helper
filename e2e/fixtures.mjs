// Generates deterministic media fixtures with the system ffmpeg (test tooling only, never shipped).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, randomBytes } from 'node:crypto';

const ff = (args) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

export function ensureFixtures(dir) {
  if (existsSync(join(dir, '.complete6'))) return;
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
    'dash-vod',
    'dash-drm',
    'dash-live',
    'subs',
    'hls-subs/sub-en',
    'dash-vod/t',
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

  // MPEG-DASH: two video representations (360p copy, 180p re-encoded for the fixture) + AAC audio, timeline template.
  ff([
    '-i',
    sample,
    '-map',
    '0:v:0',
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c:v:0',
    'copy',
    '-c:v:1',
    'libx264',
    '-preset',
    'ultrafast',
    '-filter:v:1',
    'scale=320:180',
    '-g',
    '50',
    '-keyint_min',
    '50',
    '-sc_threshold',
    '0',
    '-c:a',
    'copy',
    '-f',
    'dash',
    '-seg_duration',
    '2',
    '-use_template',
    '1',
    '-use_timeline',
    '1',
    '-adaptation_sets',
    'id=0,streams=v id=1,streams=a',
    join(dir, 'dash-vod/manifest.mpd'),
  ]);
  const vodMpd = readFileSync(join(dir, 'dash-vod/manifest.mpd'), 'utf8');
  // The same manifest, declaring Widevine (refused) and as a live stream (not supported yet). Only the manifests exist.
  writeFileSync(
    join(dir, 'dash-drm/manifest.mpd'),
    vodMpd
      .replace('<AdaptationSet id="0"', '<AdaptationSet id="0"')
      .replace(
        /(<AdaptationSet id="0"[^>]*>)/,
        '$1<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>',
      ),
  );
  writeFileSync(
    join(dir, 'dash-live/manifest.mpd'),
    vodMpd.replace('type="static"', 'type="dynamic" minimumUpdatePeriod="PT2S"'),
  );

  // ---- Subtitles (all hand-written text; nothing here needs ffmpeg)
  writeFileSync(
    join(dir, 'subs/en.vtt'),
    'WEBVTT\n\nNOTE a comment\n\nintro\n00:00:01.000 --> 00:00:02.500 line:90%\nHello <i>world</i>\n\n00:00:03.000 --> 00:00:04.000\nSecond &amp; last\n',
  );
  writeFileSync(
    join(dir, 'subs/it.srt'),
    '1\r\n00:00:00,500 --> 00:00:01,500\r\nCiao\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nMondo\r\n',
  );
  writeFileSync(
    join(dir, 'subs/en.ttml'),
    '<?xml version="1.0" encoding="utf-8"?><tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>' +
      '<p begin="00:00:01.000" end="00:00:02.000">Hello<br/>world</p>' +
      '<p begin="2.5s" end="4s"><span>Two</span> <span>spans</span></p></div></body></tt>',
  );
  // A segmented HLS WebVTT subtitle: two segments placed on the media timeline by X-TIMESTAMP-MAP.
  writeFileSync(
    join(dir, 'hls-subs/master.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n' +
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="sub-en/index.m3u8"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",SUBTITLES="subs"\n../hls/v360/index.m3u8\n',
  );
  writeFileSync(
    join(dir, 'hls-subs/sub-en/index.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\nseg0.vtt\n#EXTINF:6,\nseg1.vtt\n#EXT-X-ENDLIST\n',
  );
  writeFileSync(
    join(dir, 'hls-subs/sub-en/seg0.vtt'),
    'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:03.000\nFirst segment\n',
  );
  writeFileSync(
    join(dir, 'hls-subs/sub-en/seg1.vtt'),
    'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:1440000,LOCAL:00:00:00.000\n\n00:00:00.500 --> 00:00:02.000\nSecond segment\n',
  );
  // DASH with an IMSC1 (stpp) text track: each segment is an MP4 whose mdat holds one TTML document.
  const mp4box = (type, payload) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + payload.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, payload]);
  };
  const ttmlDoc = (begin, end, text) =>
    `<?xml version="1.0" encoding="utf-8"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="${begin}" end="${end}">${text}</p></div></body></tt>`;
  writeFileSync(
    join(dir, 'dash-vod/t/0.m4s'),
    Buffer.concat([
      mp4box('moof', Buffer.alloc(8)),
      mp4box('mdat', Buffer.from(ttmlDoc('00:00:01.000', '00:00:02.000', 'Prima riga'))),
    ]),
  );
  writeFileSync(
    join(dir, 'dash-vod/t/1.m4s'),
    Buffer.concat([
      mp4box('moof', Buffer.alloc(8)),
      mp4box('mdat', Buffer.from(ttmlDoc('00:00:03.000', '00:00:04.500', 'Seconda riga'))),
    ]),
  );
  writeFileSync(
    join(dir, 'dash-vod/manifest-subs.mpd'),
    vodMpd.replace(
      /<\/Period>/,
      '<AdaptationSet id="9" contentType="text" mimeType="application/mp4" codecs="stpp" lang="it">' +
        '<SegmentTemplate timescale="1000" duration="3000" startNumber="0" media="t/$Number$.m4s"/>' +
        '<Representation id="sub-it" bandwidth="1000"/></AdaptationSet></Period>',
    ),
  );

  // Two 70 MB "segments" (zeros): the playlist is valid, the data is not media. Used to trip the memory guard.
  const chunk = Buffer.alloc(70 * 1024 * 1024);
  writeFileSync(join(dir, 'big/seg0.ts'), chunk);
  writeFileSync(join(dir, 'big/seg1.ts'), chunk);
  writeFileSync(
    join(dir, 'big/index.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nseg0.ts\n#EXTINF:10.0,\nseg1.ts\n#EXT-X-ENDLIST\n',
  );
  writeFileSync(join(dir, '.complete6'), 'ok');
}
