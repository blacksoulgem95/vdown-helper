import { describe, expect, it } from 'vitest';
import {
  detectSubtitleFormat,
  formatSrt,
  formatVtt,
  parseSubtitles,
  parseTimestamp,
  parseTtml,
  parseVtt,
  stitchVttSegments,
  timestampMapOffset,
  toSrt,
} from '@/lib/subtitles';

const VTT = `WEBVTT - a title

NOTE this is a comment
that spans lines

STYLE
::cue { color: red }

intro
00:00:01.000 --> 00:00:03.500 align:start position:10%
<v Alice>Hello <b>there</b>,
<i>world</i> &amp; friends</v>

00:03.600 --> 00:05.000
Second &lt;cue&gt;<c.yellow> coloured</c>

00:00:05.000 --> 00:00:04.000
bad: ends before it starts

1:00:00.000 --> 1:00:02.250
An hour in
`;

describe('timestamps and format detection', () => {
  it.each([
    ['00:00:01.000', 1],
    ['01:02:03.456', 3723.456],
    ['02:03.456', 123.456],
    ['00:00:01,5', 1.5],
  ])('%s -> %s', (s, v) => expect(parseTimestamp(s)).toBeCloseTo(v as number));
  it.each(['1.5', 'abc', '00:61', ''])('rejects %j', (s) => expect(parseTimestamp(s)).toBeUndefined());
  it('detects by content', () => {
    expect(detectSubtitleFormat(VTT)).toBe('vtt');
    expect(detectSubtitleFormat('\uFEFFWEBVTT\n')).toBe('vtt');
    expect(detectSubtitleFormat('1\n00:00:01,000 --> 00:00:02,000\nhi\n')).toBe('srt');
    expect(
      detectSubtitleFormat('<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body/></tt>'),
    ).toBe('ttml');
    expect(detectSubtitleFormat('<html></html>')).toBe('unknown');
    expect(detectSubtitleFormat('')).toBe('unknown');
  });
});

describe('WebVTT', () => {
  const cues = parseVtt(VTT);
  it('reads cues, ignoring notes, styles, identifiers, settings and invalid timings', () => {
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ start: 1, end: 3.5, text: 'Hello <b>there</b>,\n<i>world</i> & friends' });
    expect(cues[1]).toEqual({ start: 3.6, end: 5, text: 'Second <cue> coloured' });
    expect(cues[2]).toMatchObject({ start: 3600, end: 3602.25 });
  });
  it('writes valid SRT (comma times, numbering, blank lines between cues)', () => {
    expect(formatSrt(cues)).toBe(
      [
        '1\n00:00:01,000 --> 00:00:03,500\nHello <b>there</b>,\n<i>world</i> & friends\n',
        '2\n00:00:03,600 --> 00:00:05,000\nSecond <cue> coloured\n',
        '3\n01:00:00,000 --> 01:00:02,250\nAn hour in\n',
      ].join('\n'),
    );
  });
  it('writes WebVTT that parses back to the same cues', () => {
    expect(parseVtt(formatVtt(cues))).toEqual(cues);
  });
  it('survives garbage', () => {
    for (const junk of ['', 'WEBVTT', 'hello', 'WEBVTT\n\n00:00:01.000 -->', '\0\0'])
      expect(() => parseVtt(junk)).not.toThrow();
    expect(parseVtt('WEBVTT\n\n')).toEqual([]);
  });
  it('removes karaoke timestamps and unknown tags but keeps text', () => {
    expect(
      parseVtt(
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<00:00:01.200>he<00:00:01.500>llo <ruby>x<rt>y</rt></ruby>',
      )[0]!.text,
    ).toBe('hello xy');
  });
});

describe('SRT in, SRT out', () => {
  it('parses SRT and re-emits it', () => {
    const srt =
      '1\r\n00:00:01,000 --> 00:00:02,500\r\nHi there\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n';
    const { format, cues } = parseSubtitles(srt);
    expect(format).toBe('srt');
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: 'Hi there' },
      { start: 3, end: 4, text: 'Bye' },
    ]);
    expect(toSrt(srt)).toContain('00:00:03,000 --> 00:00:04,000');
  });
});

describe('TTML', () => {
  const TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="25" ttp:tickRate="1000">
  <body><div>
    <p begin="00:00:01.000" end="00:00:02.500">Hello<br/>world</p>
    <p begin="3s" dur="1.5s"><span>Two </span><span>spans</span></p>
    <p begin="00:00:10:12" end="00:00:12:00">Frames</p>
    <p begin="5000t" end="6000t">Ticks</p>
    <p begin="8s">no end: dropped</p>
  </div></body>
</tt>`;
  it('reads clock, offset, frame and tick times and <br/>/<span> text', () => {
    const cues = parseTtml(TTML);
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [1, 2.5, 'Hello\nworld'],
      [3, 4.5, 'Two spans'],
      [5, 6, 'Ticks'],
      [10.48, 12, 'Frames'],
    ]);
  });
  it('is handled through the generic entry points', () => {
    expect(parseSubtitles(TTML).format).toBe('ttml');
    expect(toSrt(TTML)).toContain('00:00:01,000 --> 00:00:02,500\nHello\nworld');
  });
  it('rejects things that are not TTML', () => {
    expect(parseTtml('<html/>')).toEqual([]);
    expect(parseTtml('nope')).toEqual([]);
  });
});

describe('HLS segmented WebVTT', () => {
  const seg = (map: string | undefined, ...cues: string[]) =>
    `WEBVTT\n${map ? `X-TIMESTAMP-MAP=${map}\n` : ''}\n${cues.join('\n\n')}\n`;
  it('reads the timestamp map in either order', () => {
    expect(timestampMapOffset(seg('MPEGTS:900000,LOCAL:00:00:00.000'))).toBeCloseTo(10);
    expect(timestampMapOffset(seg('LOCAL:00:00:02.000,MPEGTS:990000'))).toBeCloseTo(9);
    expect(timestampMapOffset(seg(undefined))).toBeUndefined();
  });
  it('moves cues onto one timeline, relative to the first segment, and removes boundary duplicates', () => {
    const a = seg(
      'MPEGTS:900000,LOCAL:00:00:00.000',
      '00:00:01.000 --> 00:00:03.000\nfirst',
      '00:00:08.000 --> 00:00:12.000\nspans the boundary',
    );
    const b = seg(
      'MPEGTS:1800000,LOCAL:00:00:00.000',
      '00:00:00.000 --> 00:00:02.000\nsecond',
      '00:00:-02.000 --> 00:00:02.000\nignored',
    );
    const cues = stitchVttSegments([a, b]);
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [1, 3, 'first'],
      [8, 12, 'spans the boundary'],
      [10, 12, 'second'],
    ]);
  });
  it('without a timestamp map cue times are already absolute', () => {
    const cues = stitchVttSegments([
      seg(undefined, '00:00:05.000 --> 00:00:06.000\nx'),
      seg(undefined, '00:00:15.000 --> 00:00:16.000\ny'),
    ]);
    expect(cues.map((c) => c.start)).toEqual([5, 15]);
  });
  it('removes a cue that two segments both carry', () => {
    const dup = '00:00:09.000 --> 00:00:11.000\nsame';
    expect(stitchVttSegments([seg(undefined, dup), seg(undefined, dup)])).toHaveLength(1);
  });
});
