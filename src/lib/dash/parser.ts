import type { HlsMap, HlsSegment } from '@/types/hls';
import type {
  DashAddressing,
  DashContent,
  DashManifest,
  DashParseResult,
  DashPeriod,
  DashProtection,
  DashProtectionSystem,
  DashRepresentation,
  DashSegmentRef,
} from '@/types/dash';
import { MAX_URL_LENGTH, isSafeFetchUrl, parseUrl } from '../security';
import { childrenNamed, firstChild, localName, parseXml, type XmlNode } from '../xml';

const MAX_SEGMENTS = 50_000;
/** Total characters of segment addresses one representation may hold. */
const MAX_URI_CHARS = 8_000_000;

/** ISO 8601 duration ("PT1H2M3.5S") in seconds. Years and months are approximations, as the DASH spec allows. */
export function parseIsoDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m =
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value.trim(),
    );
  if (!m || m.slice(1).every((g) => g === undefined)) return undefined; // at least one component is required
  const n = (i: number) => Number(m[i] ?? 0);
  return n(1) * 31_536_000 + n(2) * 2_592_000 + n(3) * 86_400 + n(4) * 3600 + n(5) * 60 + n(6);
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
}

function frameRate(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(\d+)(?:\/(\d+))?$/.exec(v.trim());
  if (!m) return undefined;
  const r = Number(m[1]) / Number(m[2] ?? 1);
  return Number.isFinite(r) && r > 0 ? Math.round(r * 1000) / 1000 : undefined;
}

const PROTECTION_UUIDS: Record<string, DashProtectionSystem> = {
  'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'playready',
  '94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'fairplay',
  '5e629af5-38da-4063-8977-97ffbd9902d4': 'marlin',
  'e2719d58-a985-b3c9-781a-b030af78d30e': 'clearkey',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'clearkey', // W3C Common PSSH box system id for ClearKey
};

function protectionOf(node: XmlNode): DashProtection {
  const scheme = (node.attrs['schemeIdUri'] ?? '').trim();
  const lower = scheme.toLowerCase();
  const uuid = /^urn:uuid:([0-9a-f-]{36})$/.exec(lower)?.[1];
  let system: DashProtectionSystem = 'other';
  if (uuid) system = PROTECTION_UUIDS[uuid] ?? 'other';
  else if (lower === 'urn:mpeg:dash:mp4protection:2011') system = 'cenc';
  else if (lower.includes('clearkey')) system = 'clearkey';
  const p: DashProtection = { system, schemeIdUri: scheme.slice(0, 200) };
  const laurl = node.children.find((c) => localName(c.name).toLowerCase() === 'laurl')?.text.trim();
  if (laurl && isSafeFetchUrl(laurl)) p.licenseUrl = laurl;
  const kid = Object.entries(node.attrs).find(([k]) => localName(k) === 'default_KID')?.[1];
  if (kid) p.defaultKid = kid.slice(0, 64);
  return p;
}

/** Combine the attributes of the same element at several levels; deeper levels win. */
function mergeAttrs(nodes: Array<XmlNode | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of nodes) if (n) Object.assign(out, n.attrs);
  return out;
}

function lastDefined<T>(items: Array<T | undefined>): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (items[i] !== undefined) return items[i];
  return undefined;
}

function resolve(ref: string, base: string): string | undefined {
  if (ref.length > MAX_URL_LENGTH || base.length > MAX_URL_LENGTH) return undefined;
  const u = parseUrl(ref.trim(), base);
  return u && isSafeFetchUrl(u.href) ? u.href : undefined;
}

function contentOf(set: XmlNode, rep: XmlNode, mime: string, codecs: string | undefined): DashContent {
  const declared = (rep.attrs['contentType'] ?? set.attrs['contentType'] ?? '').toLowerCase();
  if (declared === 'video' || declared === 'audio') return declared;
  if (declared === 'text' || declared === 'image') return declared === 'text' ? 'text' : 'other';
  const m = mime.toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('text/') || m.includes('ttml') || m.includes('vtt')) return 'text';
  const c = (codecs ?? '').toLowerCase();
  if (/^(stpp|wvtt)/.test(c)) return 'text';
  if (/^(avc|hvc|hev|av01|vp0?[89]|dvh)/.test(c)) return 'video';
  if (/^(mp4a|ac-3|ec-3|opus|vorbis|flac)/.test(c)) return 'audio';
  return 'other';
}

function fileRef(node: XmlNode | undefined, base: string): DashSegmentRef | undefined {
  const src = node?.attrs['sourceURL'] ?? node?.attrs['media'];
  const range = node?.attrs['range'] ?? node?.attrs['mediaRange'];
  const url = src ? resolve(src, base) : undefined;
  if (!url) return undefined;
  const ref: DashSegmentRef = { url };
  const m = range ? /^(\d+)-(\d+)$/.exec(range.trim()) : null;
  if (m) ref.range = { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 };
  return ref;
}

function addressingOf(
  chain: { period: XmlNode; set: XmlNode; rep: XmlNode },
  baseUrl: string,
  hasExplicitBase: boolean,
): DashAddressing | undefined {
  const levels = [chain.period, chain.set, chain.rep];
  const templates = levels.map((l) => firstChild(l, 'SegmentTemplate'));
  if (templates.some(Boolean)) {
    const a = mergeAttrs(templates);
    const timelineNode = lastDefined(
      templates.map((t) => (t ? firstChild(t, 'SegmentTimeline') : undefined)),
    );
    const media = a['media'];
    if (!media || media.length > MAX_URL_LENGTH) return undefined;
    const t: DashAddressing = {
      kind: 'template',
      media,
      startNumber: num(a['startNumber']) ?? 1,
      timescale: Math.max(1, num(a['timescale']) ?? 1),
      presentationTimeOffset: num(a['presentationTimeOffset']) ?? 0,
    };
    if (a['initialization'] && a['initialization'].length <= MAX_URL_LENGTH)
      t.initialization = a['initialization'];
    const d = num(a['duration']);
    if (d && d > 0) t.duration = d;
    if (timelineNode) {
      t.timeline = childrenNamed(timelineNode, 'S').flatMap((s) => {
        const dur = num(s.attrs['d']);
        if (!dur || dur <= 0) return [];
        const entry: { t?: number; d: number; r: number } = { d: dur, r: num(s.attrs['r']) ?? 0 };
        const start = num(s.attrs['t']);
        if (start !== undefined) entry.t = start;
        return [entry];
      });
    }
    if (!t.timeline && !t.duration) return undefined;
    return t;
  }
  const lists = levels.map((l) => firstChild(l, 'SegmentList'));
  if (lists.some(Boolean)) {
    const a = mergeAttrs(lists);
    const withUrls = lastDefined(lists.filter((l) => l && childrenNamed(l, 'SegmentURL').length > 0));
    if (!withUrls) return undefined;
    const timescale = Math.max(1, num(a['timescale']) ?? 1);
    const dur = num(a['duration']);
    const init = lastDefined(lists.map((l) => (l ? firstChild(l, 'Initialization') : undefined)));
    const segments = childrenNamed(withUrls, 'SegmentURL').flatMap((s) => {
      const ref = fileRef(s, baseUrl);
      return ref ? [{ ...ref, ...(dur ? { durationSec: dur / timescale } : {}) }] : [];
    });
    if (segments.length === 0) return undefined;
    const list: DashAddressing = { kind: 'list', segments, timescale };
    const initRef = fileRef(init, baseUrl);
    if (initRef) list.initialization = initRef;
    return list;
  }
  // SegmentBase / plain BaseURL: the representation is one whole (fragmented) file.
  if (!hasExplicitBase) return undefined;
  return { kind: 'single', url: baseUrl };
}

export function parseDash(text: string, url: string): DashParseResult {
  if (!text || !text.trim()) return { ok: false, error: { code: 'empty', message: 'The manifest is empty' } };
  const root = parseXml(text);
  if (!root) return { ok: false, error: { code: 'malformed', message: 'The manifest is not valid XML' } };
  if (localName(root.name) !== 'MPD') {
    return { ok: false, error: { code: 'not-dash', message: 'The document is not an MPEG-DASH manifest' } };
  }

  const type = root.attrs['type'] === 'dynamic' ? 'dynamic' : 'static';
  let manifestBase = url;
  let explicitBase = false;
  const mpdBase = firstChild(root, 'BaseURL')?.text.trim();
  if (mpdBase) {
    const r = resolve(mpdBase, url);
    if (!r) return { ok: false, error: { code: 'unsafe-url', message: 'BaseURL uses a disallowed scheme' } };
    manifestBase = r;
    explicitBase = true;
  }

  const periods: DashPeriod[] = [];
  let cursor = 0;
  for (const periodNode of childrenNamed(root, 'Period')) {
    const duration = parseIsoDuration(periodNode.attrs['duration']);
    const start = parseIsoDuration(periodNode.attrs['start']) ?? cursor;
    let periodBase = manifestBase;
    let periodExplicit = explicitBase;
    const pb = firstChild(periodNode, 'BaseURL')?.text.trim();
    if (pb) {
      const r = resolve(pb, manifestBase);
      if (!r)
        return { ok: false, error: { code: 'unsafe-url', message: 'BaseURL uses a disallowed scheme' } };
      periodBase = r;
      periodExplicit = true;
    }
    const representations: DashRepresentation[] = [];
    for (const set of childrenNamed(periodNode, 'AdaptationSet')) {
      let setBase = periodBase;
      let setExplicit = periodExplicit;
      const sb = firstChild(set, 'BaseURL')?.text.trim();
      if (sb) {
        const r = resolve(sb, periodBase);
        if (!r)
          return { ok: false, error: { code: 'unsafe-url', message: 'BaseURL uses a disallowed scheme' } };
        setBase = r;
        setExplicit = true;
      }
      const setProtections = childrenNamed(set, 'ContentProtection').map(protectionOf);
      for (const rep of childrenNamed(set, 'Representation')) {
        let repBase = setBase;
        let repExplicit = setExplicit;
        const rb = firstChild(rep, 'BaseURL')?.text.trim();
        if (rb) {
          const r = resolve(rb, setBase);
          if (!r)
            return { ok: false, error: { code: 'unsafe-url', message: 'BaseURL uses a disallowed scheme' } };
          repBase = r;
          repExplicit = true;
        }
        const mime = rep.attrs['mimeType'] ?? set.attrs['mimeType'] ?? '';
        const codecs = rep.attrs['codecs'] ?? set.attrs['codecs'];
        const content = contentOf(set, rep, mime, codecs);
        const addressing = addressingOf({ period: periodNode, set, rep }, repBase, repExplicit);
        const id = rep.attrs['id'];
        if (!id || !addressing || content === 'other') continue;
        const r: DashRepresentation = {
          id: id.slice(0, 100),
          content,
          mimeType: mime.toLowerCase().slice(0, 100),
          bandwidth: num(rep.attrs['bandwidth']) ?? 0,
          protections: [...setProtections, ...childrenNamed(rep, 'ContentProtection').map(protectionOf)],
          baseUrl: repBase,
          addressing,
        };
        if (codecs) r.codecs = codecs.slice(0, 200);
        const w = num(rep.attrs['width'] ?? set.attrs['width']);
        const h = num(rep.attrs['height'] ?? set.attrs['height']);
        if (w) r.width = w;
        if (h) r.height = h;
        const fr = frameRate(rep.attrs['frameRate'] ?? set.attrs['frameRate']);
        if (fr) r.frameRate = fr;
        const lang = rep.attrs['lang'] ?? set.attrs['lang'];
        if (lang) r.lang = lang.slice(0, 20);
        const label = firstChild(set, 'Label')?.text.trim() || firstChild(rep, 'Label')?.text.trim();
        if (label) r.label = label.slice(0, 100);
        representations.push(r);
      }
    }
    const p: DashPeriod = { startSec: start, representations };
    if (periodNode.attrs['id']) p.id = periodNode.attrs['id'].slice(0, 100);
    if (duration !== undefined) p.durationSec = duration;
    periods.push(p);
    cursor = start + (duration ?? 0);
  }

  if (periods.length === 0 || periods.every((p) => p.representations.length === 0)) {
    return { ok: false, error: { code: 'malformed', message: 'The manifest has no usable representations' } };
  }
  const manifest: DashManifest = { url, type, periods };
  const total = parseIsoDuration(root.attrs['mediaPresentationDuration']);
  const summed = periods.every((p) => p.durationSec !== undefined)
    ? periods.reduce((n, p) => n + (p.durationSec ?? 0), 0)
    : undefined;
  const dur = total ?? summed;
  if (dur !== undefined) manifest.durationSec = dur;
  if (type === 'dynamic') {
    const ast = Date.parse(root.attrs['availabilityStartTime'] ?? '');
    if (Number.isFinite(ast)) manifest.availabilityStartMs = ast;
    const mup = parseIsoDuration(root.attrs['minimumUpdatePeriod']);
    if (mup !== undefined) manifest.minimumUpdateSec = mup;
    const tsb = parseIsoDuration(root.attrs['timeShiftBufferDepth']);
    if (tsb !== undefined) manifest.timeShiftBufferSec = tsb;
  }
  return { ok: true, manifest };
}

/** The period that holds the main content: the longest one (ads and bumpers are short periods). */
export function mainPeriodIndex(m: DashManifest): number {
  // A live stream has no durations: what is on now is the last period.
  if (m.type === 'dynamic') return Math.max(0, m.periods.length - 1);
  let best = 0;
  let bestDur = -1;
  m.periods.forEach((p, i) => {
    const d = p.durationSec ?? (m.durationSec !== undefined ? m.durationSec - p.startSec : 0);
    if (d > bestDur) {
      bestDur = d;
      best = i;
    }
  });
  return best;
}

export function periodDuration(m: DashManifest, p: DashPeriod): number | undefined {
  if (p.durationSec !== undefined) return p.durationSec;
  return m.durationSec !== undefined ? Math.max(0, m.durationSec - p.startSec) : undefined;
}

/** Fill in $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$; "$$" is a literal dollar sign. */
export function substitute(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\$(\$|[A-Za-z]+(?:%0(\d+)d)?\$)/g, (whole, body: string, width?: string) => {
    if (body === '$') return '$';
    const name = body.replace(/%0\d+d\$$/, '').replace(/\$$/, '');
    const v = vars[name];
    if (v === undefined) return whole;
    const s = String(v);
    // the printf width is the manifest's to choose: never let it build a huge string
    return width ? s.padStart(Math.min(Number(width), 20), '0') : s;
  });
}

export interface ExpandedRepresentation {
  init?: HlsMap;
  segments: HlsSegment[];
  durationSec: number;
}

export class DashExpandError extends Error {}

/** Turn a representation's addressing into a flat, ordered list of absolute segment URLs. */
export function expandSegments(
  m: DashManifest,
  period: DashPeriod,
  rep: DashRepresentation,
  /** The clock of a dynamic manifest (ms since the epoch); defaults to now. */
  nowMs: number = Date.now(),
): ExpandedRepresentation {
  const a = rep.addressing;
  const segments: HlsSegment[] = [];
  let init: HlsMap | undefined;
  let uriChars = 0;
  const push = (uri: string, duration: number, range?: { offset: number; length: number }) => {
    if (segments.length >= MAX_SEGMENTS) throw new DashExpandError('The manifest lists too many segments');
    // many long addresses are as costly as many segments: bound what a manifest can make the extension hold
    uriChars += uri.length;
    if (uriChars > MAX_URI_CHARS) throw new DashExpandError('The manifest lists too much address data');
    const seg: HlsSegment = { uri, duration, sequence: segments.length, discontinuity: false };
    if (range) seg.byteRange = range;
    segments.push(seg);
  };

  if (a.kind === 'single') {
    push(a.url, periodDuration(m, period) ?? 0);
  } else if (a.kind === 'list') {
    if (a.initialization) {
      init = { uri: a.initialization.url };
      if (a.initialization.range) init.byteRange = a.initialization.range;
    }
    for (const s of a.segments) push(s.url, s.durationSec ?? 0, s.range);
  } else {
    const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
    if (a.initialization) {
      const u = resolve(substitute(a.initialization, vars), rep.baseUrl);
      if (!u) throw new DashExpandError('The initialization URL is not allowed');
      init = { uri: u };
    }
    const url = (n: number, time: number) => {
      const u = resolve(substitute(a.media, { ...vars, Number: n, Time: time }), rep.baseUrl);
      if (!u) throw new DashExpandError('A segment URL is not allowed');
      return u;
    };
    const pDur = periodDuration(m, period);
    // A dynamic manifest has no period end: what exists is decided by the clock (ISO 23009-1 5.3.9.5.3).
    const live = m.type === 'dynamic' && m.availabilityStartMs !== undefined;
    const elapsedSec = live ? (nowMs - (m.availabilityStartMs as number)) / 1000 - period.startSec : 0;
    if (a.timeline) {
      let time = a.timeline[0]?.t ?? 0;
      let number = a.startNumber;
      for (let idx = 0; idx < a.timeline.length; idx++) {
        const s = a.timeline[idx] as { t?: number; d: number; r: number };
        if (s.t !== undefined) time = s.t;
        let repeats = s.r;
        if (repeats < 0) {
          // "until the next S, or the end of the period"
          const next = a.timeline[idx + 1]?.t;
          const end =
            next ??
            (pDur !== undefined
              ? a.presentationTimeOffset + pDur * a.timescale
              : live
                ? a.presentationTimeOffset + elapsedSec * a.timescale
                : undefined);
          if (end === undefined)
            throw new DashExpandError('An open-ended timeline needs a known period duration');
          repeats = Math.max(0, Math.ceil((end - time) / s.d) - 1);
        }
        for (let k = 0; k <= repeats; k++) {
          push(url(number, time), s.d / a.timescale);
          time += s.d;
          number++;
        }
      }
    } else if (a.duration && live && pDur === undefined) {
      // Segment k is complete (available) once its end time has passed; only the time-shift window is kept.
      const segSec = a.duration / a.timescale;
      const latest = Math.floor(elapsedSec / segSec) - 1;
      const depth = m.timeShiftBufferSec ?? 60;
      const first = Math.max(0, latest - Math.ceil(depth / segSec) + 1);
      for (let k = first; k <= latest; k++) {
        push(url(a.startNumber + k, a.presentationTimeOffset + k * a.duration), segSec);
      }
    } else if (a.duration) {
      if (pDur === undefined)
        throw new DashExpandError('A duration-based template needs a known period duration');
      const count = Math.ceil((pDur * a.timescale) / a.duration);
      for (let k = 0; k < count; k++) {
        push(url(a.startNumber + k, a.presentationTimeOffset + k * a.duration), a.duration / a.timescale);
      }
    }
  }
  if (init) for (const s of segments) s.map = init;
  const durationSec = segments.reduce((n, s) => n + s.duration, 0) || (periodDuration(m, period) ?? 0);
  const out: ExpandedRepresentation = { segments, durationSec };
  if (init) out.init = init;
  return out;
}

/** Everything needed to decide what to do with a protected manifest. */
export function protectionsOf(reps: DashRepresentation[]): {
  /** At least one non-ClearKey key system (or bare CENC with no key system we can use): refuse. */
  drm: boolean;
  /** Only ClearKey is declared. */
  clearKey: boolean;
  systems: DashProtectionSystem[];
} {
  const systems = new Set<DashProtectionSystem>();
  for (const r of reps) for (const p of r.protections) systems.add(p.system);
  const list = [...systems];
  const clearKey = list.includes('clearkey') && list.every((s) => s === 'clearkey' || s === 'cenc');
  const drm = list.length > 0 && !clearKey;
  return { drm, clearKey, systems: list };
}
