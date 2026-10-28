import { describe, expect, it } from 'vitest';
import {
  DashExpandError,
  expandSegments,
  mainPeriodIndex,
  parseDash,
  parseIsoDuration,
  protectionsOf,
  substitute,
} from '@/lib/dash/parser';
import type { DashManifest } from '@/types/dash';

const URL0 = 'https://cdn.example/show/manifest.mpd';
const mpd = (body: string, attrs = 'type="static" mediaPresentationDuration="PT20S"') =>
  `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" ${attrs}>${body}</MPD>`;

const TEMPLATE = mpd(`
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate timescale="1000" duration="4000" startNumber="1" initialization="v/$RepresentationID$/init.mp4" media="v/$RepresentationID$/seg-$Number%05d$.m4s"/>
      <Representation id="720" bandwidth="2500000" width="1280" height="720" frameRate="30000/1001" codecs="avc1.64001f"/>
      <Representation id="360" bandwidth="800000" width="640" height="360" codecs="avc1.4d401e"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="it">
      <Label>Italiano</Label>
      <SegmentTemplate timescale="48000" initialization="a/init.mp4" media="a/$Time$.m4s">
        <SegmentTimeline><S t="0" d="192000" r="2"/><S d="96000"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>
  </Period>`);

describe('parseIsoDuration / substitute', () => {
  it.each([
    ['PT0S', 0],
    ['PT20S', 20],
    ['PT1H2M3.5S', 3723.5],
    ['P1DT1H', 90000],
    ['PT0.5S', 0.5],
  ])('%s -> %s', (s, v) => expect(parseIsoDuration(s)).toBeCloseTo(v));
  it.each([undefined, '', 'P', 'PT', '20', 'abc', 'PT-5S'])('rejects %s', (s) =>
    expect(parseIsoDuration(s)).toBeUndefined(),
  );
  it('substitutes identifiers, padding and the $$ escape, leaving unknown ones alone', () => {
    expect(
      substitute('a/$RepresentationID$/$Number%05d$-$Time$.m4s', {
        RepresentationID: 'x',
        Number: 7,
        Time: 90,
      }),
    ).toBe('a/x/00007-90.m4s');
    expect(substitute('cost$$5/$Bandwidth$/$Unknown$', { Bandwidth: 100 })).toBe('cost$5/100/$Unknown$');
  });
});

describe('parseDash: structure', () => {
  const r = parseDash(TEMPLATE, URL0);
  if (!r.ok) throw new Error('fixture must parse');
  const m = r.manifest;
  it('reads type, duration, period and representations with inherited attributes', () => {
    expect(m).toMatchObject({ type: 'static', durationSec: 20 });
    const reps = m.periods[0]!.representations;
    expect(reps.map((x) => [x.id, x.content, x.height ?? 0, x.bandwidth])).toEqual([
      ['720', 'video', 720, 2_500_000],
      ['360', 'video', 360, 800_000],
      ['a1', 'audio', 0, 128_000],
    ]);
    expect(reps[0]).toMatchObject({ frameRate: 29.97, codecs: 'avc1.64001f', mimeType: 'video/mp4' });
    expect(reps[2]).toMatchObject({ lang: 'it', label: 'Italiano' });
  });
  it('expands a duration-based template to the right number of numbered URLs', () => {
    const rep = m.periods[0]!.representations[0]!;
    const e = expandSegments(m, m.periods[0]!, rep);
    expect(e.segments).toHaveLength(5); // 20 s / 4 s
    expect(e.segments[0]!.uri).toBe('https://cdn.example/show/v/720/seg-00001.m4s');
    expect(e.segments[4]!.uri).toBe('https://cdn.example/show/v/720/seg-00005.m4s');
    expect(e.init?.uri).toBe('https://cdn.example/show/v/720/init.mp4');
    expect(e.segments.every((s) => JSON.stringify(s.map) === JSON.stringify(e.init))).toBe(true);
    expect(e.durationSec).toBeCloseTo(20);
  });
  it('expands a timeline with repeats and $Time$ addressing', () => {
    const rep = m.periods[0]!.representations[2]!;
    const e = expandSegments(m, m.periods[0]!, rep);
    expect(e.segments.map((s) => s.uri.split('/').pop())).toEqual([
      '0.m4s',
      '192000.m4s',
      '384000.m4s',
      '576000.m4s',
    ]);
    expect(e.segments.map((s) => s.duration)).toEqual([4, 4, 4, 2]);
    expect(e.segments.map((s) => s.sequence)).toEqual([0, 1, 2, 3]);
  });
});

describe('parseDash: other addressing modes', () => {
  it('SegmentList with byte ranges and an initialization range', () => {
    const r = parseDash(
      mpd(`<Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000" width="640" height="360">
        <BaseURL>video.mp4</BaseURL>
        <SegmentList timescale="1000" duration="2000">
          <Initialization sourceURL="video.mp4" range="0-999"/>
          <SegmentURL media="video.mp4" mediaRange="1000-4999"/>
          <SegmentURL media="video.mp4" mediaRange="5000-8999"/>
        </SegmentList></Representation></AdaptationSet></Period>`),
      URL0,
    );
    if (!r.ok) throw new Error('parse');
    const e = expandSegments(r.manifest, r.manifest.periods[0]!, r.manifest.periods[0]!.representations[0]!);
    expect(e.init).toEqual({
      uri: 'https://cdn.example/show/video.mp4',
      byteRange: { offset: 0, length: 1000 },
    });
    expect(e.segments.map((s) => s.byteRange)).toEqual([
      { offset: 1000, length: 4000 },
      { offset: 5000, length: 4000 },
    ]);
    expect(e.segments.map((s) => s.duration)).toEqual([2, 2]);
  });
  it('SegmentBase / BaseURL only: one whole file', () => {
    const r = parseDash(
      mpd(`<Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1000">
        <BaseURL>movie.mp4</BaseURL><SegmentBase indexRange="800-1500"><Initialization range="0-799"/></SegmentBase>
        </Representation></AdaptationSet></Period>`),
      URL0,
    );
    if (!r.ok) throw new Error('parse');
    const e = expandSegments(r.manifest, r.manifest.periods[0]!, r.manifest.periods[0]!.representations[0]!);
    expect(e.segments.map((s) => s.uri)).toEqual(['https://cdn.example/show/movie.mp4']);
  });
  it('drops a representation that has no way to be addressed', () => {
    const r = parseDash(
      mpd(
        `<Period><AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1"/></AdaptationSet></Period>`,
      ),
      URL0,
    );
    expect(r.ok).toBe(false);
  });
  it('an open-ended timeline (r=-1) runs to the end of the period', () => {
    const r = parseDash(
      mpd(`<Period duration="PT10S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" media="s$Number$.m4s">
        <SegmentTimeline><S t="0" d="2" r="-1"/></SegmentTimeline></SegmentTemplate><Representation id="v" bandwidth="1"/></AdaptationSet></Period>`),
      URL0,
    );
    if (!r.ok) throw new Error('parse');
    const e = expandSegments(r.manifest, r.manifest.periods[0]!, r.manifest.periods[0]!.representations[0]!);
    expect(e.segments).toHaveLength(5);
  });
  it('refuses to expand when the period length is unknown', () => {
    const r = parseDash(
      mpd(
        `<Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" media="s$Number$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period>`,
        'type="static"',
      ),
      URL0,
    );
    if (!r.ok) throw new Error('parse');
    expect(() =>
      expandSegments(r.manifest, r.manifest.periods[0]!, r.manifest.periods[0]!.representations[0]!),
    ).toThrow(DashExpandError);
  });
  it('caps the number of segments', () => {
    const r = parseDash(
      mpd(
        `<Period duration="PT1000000S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="1" media="s$Number$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period>`,
      ),
      URL0,
    );
    if (!r.ok) throw new Error('parse');
    expect(() =>
      expandSegments(r.manifest, r.manifest.periods[0]!, r.manifest.periods[0]!.representations[0]!),
    ).toThrow(/too many/);
  });
});

describe('parseDash: periods, base URLs, dynamic', () => {
  it('chooses the longest period as the main content and resolves nested BaseURLs', () => {
    const r = parseDash(
      mpd(
        `<BaseURL>https://other.example/root/</BaseURL>
         <Period id="ad" duration="PT5S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="5" media="ad.m4s"/><Representation id="ad" bandwidth="1"/></AdaptationSet></Period>
         <Period id="main" duration="PT100S"><BaseURL>main/</BaseURL><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="50" media="m$Number$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period>`,
        'type="static" mediaPresentationDuration="PT105S"',
      ),
      URL0,
    );
    if (!r.ok) throw new Error('parse');
    expect(r.manifest.periods.map((p) => [p.id, p.startSec])).toEqual([
      ['ad', 0],
      ['main', 5],
    ]);
    const i = mainPeriodIndex(r.manifest);
    expect(i).toBe(1);
    const e = expandSegments(r.manifest, r.manifest.periods[i]!, r.manifest.periods[i]!.representations[0]!);
    expect(e.segments.map((s) => s.uri)).toEqual([
      'https://other.example/root/main/m1.m4s',
      'https://other.example/root/main/m2.m4s',
    ]);
  });
  it('flags dynamic manifests', () => {
    const r = parseDash(TEMPLATE.replace('type="static"', 'type="dynamic"'), URL0);
    expect(r.ok && r.manifest.type).toBe('dynamic');
  });
  it('rejects non-http(s) base URLs and segment URLs', () => {
    expect(parseDash(mpd('<BaseURL>javascript:alert(1)</BaseURL><Period/>'), URL0)).toMatchObject({
      ok: false,
      error: { code: 'unsafe-url' },
    });
    const r = parseDash(
      mpd(
        `<Period duration="PT4S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" media="file:///etc/passwd?$Number$"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period>`,
      ),
      URL0,
    );
    if (!r.ok) throw new Error('parse');
    // an absolute file: URL stays absolute when resolved, and is refused
    expect(() =>
      expandSegments(r.manifest, r.manifest.periods[0]!, r.manifest.periods[0]!.representations[0]!),
    ).toThrow(/not allowed/);
  });
  it.each([
    ['empty', '', 'empty'],
    ['not xml', 'hello', 'malformed'],
    ['wrong root', '<html/>', 'not-dash'],
    ['no periods', mpd(''), 'malformed'],
  ])('%s -> %s', (_n, text, code) => {
    expect(parseDash(text, URL0)).toMatchObject({ ok: false, error: { code } });
  });
});

describe('content protection', () => {
  const protectedMpd = (cp: string) =>
    mpd(
      `<Period duration="PT4S"><AdaptationSet mimeType="video/mp4">${cp}<SegmentTemplate timescale="1" duration="2" media="s$Number$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period>`,
    );
  const rep = (cp: string) => {
    const r = parseDash(protectedMpd(cp), URL0);
    if (!r.ok) throw new Error('parse');
    return r.manifest.periods[0]!.representations;
  };
  it('Widevine / PlayReady / FairPlay are DRM', () => {
    for (const uuid of [
      'EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED',
      '9a04f079-9840-4286-ab92-e65be0885f95',
      '94ce86fb-07ff-4f43-adb8-93d2fa968ca2',
    ]) {
      const p = protectionsOf(rep(`<ContentProtection schemeIdUri="urn:uuid:${uuid}"/>`));
      expect(p.drm).toBe(true);
    }
  });
  it('bare CENC with no usable key system counts as DRM', () => {
    expect(
      protectionsOf(rep('<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>'))
        .drm,
    ).toBe(true);
  });
  it('ClearKey (alone, or with the generic CENC marker) is not DRM, and its licence URL is read', () => {
    const reps =
      rep(`<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="abc"/>
      <ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e"><clearkey:Laurl xmlns:clearkey="http://dashif.org/guidelines/clearKey">https://keys.example/license</clearkey:Laurl></ContentProtection>`);
    const p = protectionsOf(reps);
    expect(p).toMatchObject({ drm: false, clearKey: true });
    expect(reps[0]!.protections.find((x) => x.system === 'clearkey')?.licenseUrl).toBe(
      'https://keys.example/license',
    );
  });
  it('mixing ClearKey with a real DRM system is DRM', () => {
    const p = protectionsOf(
      rep(
        `<ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e"/><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>`,
      ),
    );
    expect(p.drm).toBe(true);
  });
  it('no protection elements: nothing to refuse', () => {
    expect(protectionsOf(rep(''))).toMatchObject({ drm: false, clearKey: false, systems: [] });
  });
});

describe('types', () => {
  it('manifests carry the URL they came from', () => {
    const r = parseDash(TEMPLATE, URL0);
    expect((r.ok ? r.manifest : ({} as DashManifest)).url).toBe(URL0);
  });
});

describe('a real ffmpeg-generated manifest', () => {
  const REAL = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
	xmlns="urn:mpeg:dash:schema:mpd:2011"
	xmlns:xlink="http://www.w3.org/1999/xlink"
	xsi:schemaLocation="urn:mpeg:DASH:schema:MPD:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd"
	profiles="urn:mpeg:dash:profile:isoff-live:2011"
	type="static"
	mediaPresentationDuration="PT6.0S"
	maxSegmentDuration="PT2.0S"
	minBufferTime="PT4.0S">
	<ProgramInformation>
	</ProgramInformation>
	<ServiceDescription id="0">
	</ServiceDescription>
	<Period id="0" start="PT0.0S">
		<AdaptationSet id="0" contentType="video" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true" frameRate="25/1" maxWidth="640" maxHeight="360" par="16:9" lang="und">
			<Representation id="0" mimeType="video/mp4" codecs="avc1.42c01e" bandwidth="1816674" width="640" height="360" sar="1:1">
				<SegmentTemplate timescale="12800" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
					<SegmentTimeline>
						<S t="0" d="25600" r="2" />
					</SegmentTimeline>
				</SegmentTemplate>
			</Representation>
			<Representation id="1" mimeType="video/mp4" codecs="avc1.42c00c" bandwidth="591814" width="320" height="180" sar="1:1">
				<SegmentTemplate timescale="12800" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
					<SegmentTimeline>
						<S t="0" d="25600" r="2" />
					</SegmentTimeline>
				</SegmentTemplate>
			</Representation>
		</AdaptationSet>
		<AdaptationSet id="1" contentType="audio" startWithSAP="1" segmentAlignment="true" bitstreamSwitching="true" lang="und">
			<Representation id="2" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="96315" audioSamplingRate="44100">
				<AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="1" />
				<SegmentTemplate timescale="44100" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
					<SegmentTimeline>
						<S t="0" d="88064" />
						<S d="89088" />
						<S d="87448" />
					</SegmentTimeline>
				</SegmentTemplate>
			</Representation>
		</AdaptationSet>
	</Period>
</MPD>
`;
  it('parses (xsi attributes, per-representation templates, shared init pattern)', () => {
    const r = parseDash(REAL, 'https://cdn.example/d/manifest.mpd');
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const period = r.manifest.periods[0]!;
    expect(period.representations.map((x) => [x.id, x.content, x.height ?? 0])).toEqual([
      ['0', 'video', 360],
      ['1', 'video', 180],
      ['2', 'audio', 0],
    ]);
    expect(r.manifest.durationSec).toBe(6);
    const v = expandSegments(r.manifest, period, period.representations[0]!);
    expect(v.init?.uri).toBe('https://cdn.example/d/init-stream0.m4s');
    expect(v.segments.map((s) => s.uri.split('/').pop())).toEqual([
      'chunk-stream0-00001.m4s',
      'chunk-stream0-00002.m4s',
      'chunk-stream0-00003.m4s',
    ]);
    expect(v.durationSec).toBeCloseTo(6);
    const a = expandSegments(r.manifest, period, period.representations[2]!);
    expect(a.segments).toHaveLength(3);
    expect(a.durationSec).toBeCloseTo(6, 0);
  });
});

describe('dynamic (live) manifests', () => {
  const START = '2026-01-01T00:00:00Z';
  const LIVE = mpd(
    `<Period start="PT0S"><AdaptationSet contentType="video" mimeType="video/mp4">
       <SegmentTemplate timescale="1000" duration="2000" startNumber="1" initialization="init.mp4" media="seg-$Number$.m4s"/>
       <Representation id="v" bandwidth="1000000" codecs="avc1.4d401e"/>
     </AdaptationSet></Period>`,
    `type="dynamic" availabilityStartTime="${START}" minimumUpdatePeriod="PT2S" timeShiftBufferDepth="PT8S"`,
  );
  const at = (sec: number) => Date.parse(START) + sec * 1000;
  const expand = (nowSec: number) => {
    const r = parseDash(LIVE, URL0);
    if (!r.ok) throw new Error('parse');
    const m = r.manifest;
    const p = m.periods[mainPeriodIndex(m)]!;
    return { m, e: expandSegments(m, p, p.representations[0]!, at(nowSec)) };
  };

  it('reads the clock attributes', () => {
    const r = parseDash(LIVE, URL0);
    expect(r.ok && r.manifest).toMatchObject({
      type: 'dynamic',
      availabilityStartMs: Date.parse(START),
      minimumUpdateSec: 2,
      timeShiftBufferSec: 8,
    });
  });

  it('lists the segments that are complete now, within the time-shift window, numbered from startNumber', () => {
    const { e } = expand(21); // segment k ends at 2(k+1) s: segments 0..9 are complete
    const urls = e.segments.map((s) => s.uri.split('/').pop());
    expect(urls).toEqual(['seg-7.m4s', 'seg-8.m4s', 'seg-9.m4s', 'seg-10.m4s']);
    expect(e.init?.uri).toBe('https://cdn.example/show/init.mp4');
  });

  it('moves with the clock, and lists nothing before the first segment is complete', () => {
    expect(expand(1).e.segments).toEqual([]);
    expect(expand(2.5).e.segments.map((s) => s.uri.split('/').pop())).toEqual(['seg-1.m4s']);
    expect(expand(30).e.segments.at(-1)?.uri).toMatch(/seg-15\.m4s$/);
  });

  it('uses the last period as the main one', () => {
    const r = parseDash(
      mpd(
        `<Period id="a" start="PT0S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" media="a$Number$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period>
         <Period id="b" start="PT100S"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="2" media="b$Number$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period>`,
        `type="dynamic" availabilityStartTime="${START}"`,
      ),
      URL0,
    );
    expect(r.ok && mainPeriodIndex(r.manifest)).toBe(1);
  });
});

describe('hostile manifests cannot amplify memory (security review M2)', () => {
  const run = (media: string, extra = '') => {
    const r = parseDash(
      mpd(
        `<Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="1" duration="1" media="${media}" ${extra}/><Representation id="v" bandwidth="1"/></AdaptationSet></Period>`,
        'type="static" mediaPresentationDuration="PT10S"',
      ),
      URL0,
    );
    if (!r.ok) return undefined;
    const p = r.manifest.periods[0]!;
    return expandSegments(r.manifest, p, p.representations[0]!);
  };
  it('clamps the printf width of $Number%0Nd$', () => {
    const e = run('s-$Number%050000000d$.m4s')!;
    expect(Math.max(...e.segments.map((s) => s.uri.length))).toBeLessThan(200);
  });
  it('refuses a template longer than a URL may be, and a huge address', () => {
    expect(run(`https://x.test/${'a'.repeat(9000)}$Number$`)).toBeUndefined();
    expect(substitute('$Number%020d$', { Number: 5 })).toBe('00000000000000000005');
  });
});
