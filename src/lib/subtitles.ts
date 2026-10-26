import { decodeEntities, localName, parseXml, type XmlNode } from './xml';

/** A single caption. Times are seconds on the media timeline. */
export interface Cue {
  start: number;
  end: number;
  /** Plain text with `<b>`/`<i>`/`<u>` kept (SRT-compatible); lines separated by "\n". */
  text: string;
}

export type SubtitleFormat = 'vtt' | 'srt' | 'ttml' | 'unknown';

const MAX_CUES = 100_000;

/** Best guess of what a document is, from its content (never from its name). */
export function detectSubtitleFormat(text: string): SubtitleFormat {
  const t = text.replace(/^\uFEFF/, '').trimStart();
  if (t.startsWith('WEBVTT')) return 'vtt';
  if (/^<\?xml|^<tt[\s>:]|^<[a-z0-9]+:tt[\s>]/i.test(t) && /<(\w+:)?tt[\s>]/.test(t.slice(0, 2000)))
    return 'ttml';
  if (/^\d+\s*\r?\n\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(t)) return 'srt';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------------------------
// WebVTT

/** "01:02:03.456", "02:03.456" or SRT's "01:02:03,456" to seconds. */
export function parseTimestamp(value: string): number | undefined {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
  if (!m) return undefined;
  const ms = Number(m[4]!.padEnd(3, '0'));
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

const TIMING = /^\s*(\S+)\s+-->\s+(\S+)/;

/** Convert WebVTT inline markup to the small SRT-safe subset. */
function cleanVttText(raw: string): string {
  return decodeEntities(
    raw
      .replace(/<(\/?)(b|i|u)(?:\.[^>]*)?>/gi, '<$1$2>')
      .replace(/<\/?(?:c|v|lang|ruby|rt|rp)(?:[.\s][^>]*)?>/gi, '')
      .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '') // karaoke timestamps
      .replace(/<(?!\/?[biu]>)[^>]*>/g, '')
      .replace(/&nbsp;/g, ' '),
  );
}

export function parseVtt(text: string): Cue[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const cues: Cue[] = [];
  let i = 0;
  while (i < lines.length && !lines[i]!.startsWith('WEBVTT')) i++;
  i++;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    // Skip NOTE / STYLE / REGION blocks.
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(line)) {
      while (i < lines.length && lines[i]!.trim() !== '') i++;
      continue;
    }
    // Optional cue identifier line, then the timing line.
    let timing = TIMING.exec(line);
    if (!timing && i + 1 < lines.length) {
      const next = TIMING.exec(lines[i + 1]!);
      if (next) {
        timing = next;
        i++;
      }
    }
    if (!timing) {
      i++;
      continue;
    }
    i++;
    const start = parseTimestamp(timing[1]!);
    const end = parseTimestamp(timing[2]!);
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') body.push(lines[i++]!);
    if (start === undefined || end === undefined || end < start) continue;
    const textOut = cleanVttText(body.join('\n')).trim();
    if (textOut) cues.push({ start, end, text: textOut });
    if (cues.length >= MAX_CUES) break;
  }
  return cues;
}

/** The `X-TIMESTAMP-MAP` of a WebVTT segment: seconds to add to cue times to get media (MPEG-TS) time. */
export function timestampMapOffset(text: string): number | undefined {
  const m =
    /X-TIMESTAMP-MAP=(?:[^\r\n]*?)MPEGTS:(\d+)(?:[^\r\n]*?)LOCAL:([\d:.]+)|X-TIMESTAMP-MAP=(?:[^\r\n]*?)LOCAL:([\d:.]+)(?:[^\r\n]*?)MPEGTS:(\d+)/.exec(
      text.slice(0, 2000),
    );
  if (!m) return undefined;
  const mpegts = Number(m[1] ?? m[4]);
  const local = parseTimestamp((m[2] ?? m[3]) as string);
  if (!Number.isFinite(mpegts) || local === undefined) return undefined;
  return mpegts / 90000 - local;
}

/**
 * Join the segments of an HLS WebVTT subtitle playlist into one cue list. With X-TIMESTAMP-MAP the cues are moved
 * onto the media timeline and shifted so the earliest segment starts at zero; without it cue times are already
 * absolute (per RFC 8216). Cues repeated at segment boundaries are removed.
 */
export function stitchVttSegments(segments: string[]): Cue[] {
  const offsets = segments.map(timestampMapOffset);
  const known = offsets.filter((o): o is number => o !== undefined);
  const base = known.length > 0 ? Math.min(...known) : 0;
  const seen = new Set<string>();
  const out: Cue[] = [];
  segments.forEach((seg, idx) => {
    const shift = (offsets[idx] ?? base) - base;
    for (const c of parseVtt(seg)) {
      const cue = { start: c.start + shift, end: c.end + shift, text: c.text };
      const key = `${cue.start.toFixed(3)}|${cue.end.toFixed(3)}|${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cue);
    }
  });
  return out.sort((a, b) => a.start - b.start || a.end - b.end).slice(0, MAX_CUES);
}

// ---------------------------------------------------------------------------------------------------------------
// TTML

function ttmlTime(value: string | undefined, frameRate: number, tickRate: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  let m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(v);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
  m = /^(\d+):(\d{2}):(\d{2}):(\d+)(?:\.\d+)?$/.exec(v); // hh:mm:ss:frames
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / frameRate;
  m = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(v);
  if (m) {
    const n = Number(m[1]);
    return { h: n * 3600, m: n * 60, s: n, ms: n / 1000, f: n / frameRate, t: n / tickRate }[m[2] as 'h'];
  }
  return undefined;
}

/** Text of a `<p>`: character data and `<span>`s in document order, `<br/>` as a line break. */
function ttmlText(node: XmlNode): string {
  let out = '';
  for (const part of node.content) {
    if (typeof part === 'string') out += part;
    else {
      const ln = localName(part.name);
      if (ln === 'br') out += '\n';
      else if (ln === 'span') out += ttmlText(part);
    }
  }
  return out;
}

export function parseTtml(text: string): Cue[] {
  const root = parseXml(text);
  if (!root || localName(root.name) !== 'tt') return [];
  const frameRate = Number(Object.entries(root.attrs).find(([k]) => localName(k) === 'frameRate')?.[1]) || 30;
  const tickRate =
    Number(Object.entries(root.attrs).find(([k]) => localName(k) === 'tickRate')?.[1]) || 10_000_000;
  const cues: Cue[] = [];
  const visit = (node: XmlNode, inherit: number) => {
    const ln = localName(node.name);
    const begin = ttmlTime(node.attrs['begin'], frameRate, tickRate);
    const base = inherit + (begin ?? 0);
    if (ln === 'p') {
      const start = begin !== undefined ? inherit + begin : inherit;
      let end = ttmlTime(node.attrs['end'], frameRate, tickRate);
      const dur = ttmlTime(node.attrs['dur'], frameRate, tickRate);
      end = end !== undefined ? inherit + end : dur !== undefined ? start + dur : undefined;
      const body = ttmlText(node)
        .replace(/[ \t\r]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .trim();
      if (end !== undefined && end >= start && body && cues.length < MAX_CUES)
        cues.push({ start, end, text: body });
      return;
    }
    for (const c of node.children) visit(c, ln === 'div' || ln === 'body' ? base : inherit);
  };
  visit(root, 0);
  return cues.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------------------------------------------
// Output

function srtTime(sec: number): string {
  const ms = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms % 1000, 3)}`;
}

export function formatSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

function vttTime(sec: number): string {
  return srtTime(sec).replace(',', '.');
}

/** WebVTT cue text: keep `<b>`/`<i>`/`<u>`, escape everything else that WebVTT would read as markup. */
function vttEscape(text: string): string {
  return text
    .split(/(<\/?[biu]>)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/&/g, '&amp;').replace(/</g, '&lt;')))
    .join('')
    .replace(/\n{2,}/g, '\n') // a blank line would end the cue
    .replace(/-->/g, '--&gt;');
}

export function formatVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues
    .map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${vttEscape(c.text)}\n`)
    .join('\n')}`;
}

/** Parse any supported subtitle document into cues (SRT is parsed through the VTT reader: same layout). */
export function parseSubtitles(text: string): { format: SubtitleFormat; cues: Cue[] } {
  const format = detectSubtitleFormat(text);
  if (format === 'vtt') return { format, cues: parseVtt(text) };
  if (format === 'srt')
    return {
      format,
      cues: parseVtt(`WEBVTT\n\n${text.replace(/^\uFEFF/, '').replace(/(\d),(\d{3})/g, '$1.$2')}`),
    };
  if (format === 'ttml') return { format, cues: parseTtml(text) };
  return { format, cues: [] };
}

export function toSrt(text: string): string | undefined {
  const { cues } = parseSubtitles(text);
  return cues.length > 0 ? formatSrt(cues) : undefined;
}
