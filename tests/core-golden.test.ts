// The Rust core, as the extension runs it (wasm), against the golden fixtures recorded from the former TypeScript
// implementation. `cargo test` replays the same files natively (core/tests/golden.rs).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyPlaylist, parseHls } from '@/lib/hls/parser';
import { parseAttributes } from '@/lib/hls/attributes';
import { decodeEntities, parseXml } from '@/lib/xml';
import * as dash from '@/lib/dash/parser';
import { dashRef, parseDashRef } from '@/lib/dash/ref';
import { dashResource, mediaPlaylistVerdict } from '@/lib/analyze';
import { inspectDashRepresentation, inspectMediaPlaylist, originsOf, sampleByOrigin } from '@/lib/inspect';
import * as filetypes from '@/lib/filetypes';
import { sniffMime } from '@/lib/sniff';
import * as security from '@/lib/security';
import * as settings from '@/lib/settings';
import * as compat from '@/lib/compat';
import { buildFfmpegArgs } from '@/lib/ffmpegArgs';
import * as request from '@/lib/request';
import * as media from '@/lib/media';
import * as replayHeaders from '@/lib/replay';
import * as tabs from '@/lib/tabs';
import * as zip from '@/lib/zip';
import * as resources from '@/lib/resources';
import * as queue from '@/lib/queue';
import * as dataUrl from '@/lib/dataUrl';
import * as hookData from '@/lib/hookData';
import * as subtitles from '@/lib/subtitles';
import * as subtitleBytes from '@/lib/subtitleBytes';
import * as metadata from '@/lib/metadata';
import * as mse from '@/lib/mse';
import * as mseParts from '@/lib/mseParts';
import { core } from '@/lib/core';

interface Case {
  fn: string;
  args: unknown[];
  result?: unknown;
  throws?: string;
  /** The date the recorded call saw (request builders put it in file names). */
  today?: string;
}

function pick(m: Record<string, unknown>, names: string[]): Record<string, (...args: never[]) => unknown> {
  return Object.fromEntries(names.map((n) => [n, m[n] as (...args: never[]) => unknown]));
}

/** `{ $bytes: [...] }` arguments are Uint8Arrays and `{ $map: [...] }` ones are Maps, at any depth. */
const revive = (a: unknown): unknown => {
  if (Array.isArray(a)) return a.map(revive);
  if (!a || typeof a !== 'object') return a;
  if ('$bytes' in a) return Uint8Array.from((a as { $bytes: number[] }).$bytes);
  if ('$map' in a)
    return new Map((a as { $map: Array<[unknown, unknown]> }).$map.map(([k, v]) => [k, revive(v)]));
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, revive(v)]));
};

/** A result as it was recorded: through JSON, with byte arrays as `{ $bytes }` (undefined fields and Infinity go). */
const asRecorded = (v: unknown): unknown =>
  v === undefined
    ? undefined
    : JSON.parse(JSON.stringify(v, (_k, x: unknown) => (x instanceof Uint8Array ? { $bytes: [...x] } : x)));

const run: Record<string, (...args: never[]) => unknown> = {
  parseHls,
  classifyPlaylist,
  parseAttributes,
  parseXml,
  decodeEntities,
  dashRef,
  parseDashRef,
  parseDash: dash.parseDash,
  parseIsoDuration: dash.parseIsoDuration,
  mainPeriodIndex: dash.mainPeriodIndex,
  periodDuration: dash.periodDuration,
  substitute: dash.substitute,
  expandSegments: dash.expandSegments,
  protectionsOf: dash.protectionsOf,
  dashResource,
  mediaPlaylistVerdict,
  inspectMediaPlaylist,
  inspectDashRepresentation,
  originsOf,
  sampleByOrigin,
  ...pick(filetypes, [
    'fileKindOfExtension',
    'extensionForMime',
    'fileKindOfMime',
    'urlExtension',
    'fileStem',
  ]),
  sniffMime,
  ...pick(security, [
    'isSafeFetchUrl',
    'isBlobUrl',
    'isPrivateHost',
    'mayExtensionFetch',
    'normalizeUrl',
    'redactUrl',
    'redactText',
    'sanitizeFilename',
    'sanitizeSubfolder',
    'asciiFileName',
    'withExtension',
    'renderNameTemplate',
  ]),
  ...pick(settings, ['sanitizeSettings', 'migrateHookDefault', 'pickVariantIndex']),
  ...pick(compat, [
    'videoFitsContainer',
    'audioFitsContainer',
    'sourceFitsContainer',
    'fileExtension',
    'audioExtension',
    'planOutput',
    'bitrateOptions',
  ]),
  buildFfmpegArgs,
  ...pick(request, [
    'audioOptions',
    'defaultChoices',
    'workableChoices',
    'defaultSubtitleOutput',
    'buildZipRequest',
    'buildRequest',
    'qualityLabelFor',
    'planFromRequest',
    'buildLiveRequest',
    'buildRecordRequest',
    'buildCaptureRequest',
    'zipLimitBytes',
    'sanitizeRequest',
  ]),
  // VDH-064
  ...pick(media, [
    'formatBytes',
    'formatDuration',
    'formatBitrate',
    'formatSpeed',
    'qualityTag',
    'resolutionLabel',
    'formatFromMime',
    'extensionOf',
    'formatFromUrl',
    'mediaTypeOf',
    'inferTitle',
    'describeCodecs',
    'estimateBytes',
  ]),
  ...pick(replayHeaders, ['replayHeadersFor', 'replayDomains', 'ruleIdFor']),
  ...pick(tabs, ['tabOf', 'splitByTab', 'activeTab', 'imageMeetsMinimum', 'groupByFrame', 'emptyCause']),
  ...pick(zip, ['shouldDeflate', 'zipEntryNames', 'planZip']),
  ...pick(resources, [
    'resourceId',
    'mergeResource',
    'dedupeResources',
    'groupResources',
    'hideCoveredVariants',
    'rankResources',
    'bestMatch',
    'bestHeight',
  ]),
  ...pick(queue, [
    'popupQueue',
    'stagesFor',
    'createJob',
    'canTransition',
    'transition',
    'failJob',
    'canRetry',
    'retryJob',
    'withProgress',
    'canRestage',
    'restage',
    'isActive',
    'isTerminal',
    'isQueued',
    'canStop',
  ]),
  speedMeterTrace: ((events: Array<[number, number, number | null]>) => {
    const m = new queue.SpeedMeter();
    return events.map(([b, n, rem]) => {
      m.update(b, n);
      return [m.bytesPerSecond ?? null, m.etaSeconds(rem ?? undefined) ?? null];
    });
  }) as (...args: never[]) => unknown,
  ...pick(dataUrl, [
    'inspectDataUrl',
    'dataHandle',
    'dataLabel',
    'isDataLabel',
    'exceedsHeldLimit',
    'blobLabel',
  ]),
  ...pick(hookData, [
    'isInteresting',
    'parseHookReport',
    'hookCandidates',
    'protectedKeySystems',
    'markProtectedFrames',
    'mseMissingReason',
    'markMseResources',
  ]),
  ...pick(subtitles, [
    'detectSubtitleFormat',
    'parseTimestamp',
    'parseVtt',
    'timestampMapOffset',
    'stitchVttSegments',
    'parseTtml',
    'formatSrt',
    'formatVtt',
    'parseSubtitles',
    'toSrt',
  ]),
  ...pick(subtitleBytes, ['decodeSubtitleBytes', 'mdatPayloads', 'cuesFromBytes', 'assembleCues']),
  ...pick(metadata, [
    'safeAbs',
    'mediaTypeOfMime',
    'mediaFromMetaTags',
    'mediaFromJsonLd',
    'mediaFromLinks',
    'mediaFromFeed',
  ]),
  ...pick(mse, ['parseInit', 'parseFragment', 'mediaStartInInit']),
  ...pick(mseParts, ['chunkSignature', 'planParts']),
  classifierTrace: ((calls: Array<[string, number, Uint8Array, number]>) => {
    const c = new mseParts.ChunkClassifier();
    return calls.map(([t, seq, b, off]) => c.classifyAll(t, seq, b, off));
  }) as (...args: never[]) => unknown,
};

function cases(file: string): Case[] {
  return readFileSync(resolve(__dirname, '../core/fixtures/golden', file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Case);
}

afterEach(() => vi.useRealTimers());

/** `recorded`: the results were recorded through JSON (VDH-064), so the outputs are compared the same way. */
function replay(file: string, min: number, recorded = false): void {
  const all = cases(file);
  it('has the recorded cases', () => expect(all.length).toBeGreaterThan(min));
  it('gives the same results as the TypeScript implementation did', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const c of all) {
      const fn = run[c.fn] as ((...a: unknown[]) => unknown) | undefined;
      if (!fn) throw new Error(`no export for ${c.fn}`);
      if (c.today) vi.setSystemTime(new Date(`${c.today}T12:00:00Z`));
      // JSON recorded an argument left out (a default) as null
      const args = c.args.map((a) => (recorded && a === null ? undefined : revive(a)));
      const what = `${c.fn}(${JSON.stringify(c.args).slice(0, 200)})`;
      if (c.throws !== undefined) expect(() => fn(...args), what).toThrow(c.throws);
      else if (recorded) expect(asRecorded(fn(...args)), what).toStrictEqual(c.result);
      else expect(fn(...args), what).toStrictEqual(c.result);
    }
  });
}

describe('golden: hls', () => replay('hls.jsonl', 400));
describe('golden: dash and xml', () => replay('dash.jsonl', 500));
describe('golden: verdicts and inspections', () => replay('analyze.jsonl', 150));
describe('golden: file types, sniffing and security', () => replay('files.jsonl', 3000));
describe('golden: planner and settings', () => replay('planner.jsonl', 1000));
describe('golden: requests', () => replay('requests.jsonl', 1500));
describe('golden: media, resources, tabs, ZIP, queue, data: URLs', () => replay('ui.jsonl', 3500, true));
describe('golden: hook reports and page metadata', () => replay('page.jsonl', 350, true));
describe('golden: subtitles', () => replay('subtitles.jsonl', 200, true));
describe('golden: MediaSource chunks and parts', () => replay('mse.jsonl', 300, true));

describe('data: URLs', () => {
  // The page scripts keep a TypeScript copy (they never load the core); both must give the same answers.
  it('the core agrees with the copy the page scripts use', () => {
    const fns: Record<string, (u: string) => unknown> = {
      inspectDataUrl: core.inspectDataUrl,
      dataHandle: core.dataHandle,
      isDataLabel: core.isDataLabel,
    };
    let n = 0;
    for (const c of cases('ui.jsonl')) {
      const fn = fns[c.fn];
      if (!fn) continue;
      n++;
      expect(asRecorded(fn(c.args[0] as string)), c.fn).toStrictEqual(c.result);
    }
    expect(n).toBeGreaterThan(100);
  });
});

describe('constants', () => {
  it("the format sets, tabs and stages the TypeScript keeps are the core's", () => {
    for (const f of media.AUDIO_ONLY_FORMATS) expect(media.mediaTypeOf(f), f).toBe('audio');
    for (const f of media.VIDEO_FORMATS) expect(media.mediaTypeOf(f), f).toBe('video');
    const formats = ['vtt', 'srt', 'ttml', 'mp4', 'webm', 'mp3', 'dash', 'm3u', 'unknown', 'blob'] as const;
    for (const f of formats)
      expect(media.SUBTITLE_FILE_FORMATS.has(f), f).toBe(['vtt', 'srt', 'ttml'].includes(f));
    expect(queue.ACTIVE_STAGES).toEqual(['preparing', 'downloading', 'recording', 'merging', 'encoding']);
    expect(queue.TERMINAL_STAGES).toEqual(['completed', 'failed', 'cancelled']);
    expect(core.activeTab({}, undefined)).toBe(tabs.TAB_ORDER[0]);
  });
});

describe('settings defaults', () => {
  it('DEFAULT_SETTINGS and LIMITS are what the core sanitises to', () => {
    expect(settings.sanitizeSettings(undefined)).toStrictEqual(settings.DEFAULT_SETTINGS);
    for (const [key, range] of Object.entries(settings.LIMITS)) {
      if (!('min' in range)) continue;
      const low = settings.sanitizeSettings({ [key]: range.min - 1000 }) as unknown as Record<string, number>;
      const high = settings.sanitizeSettings({ [key]: range.max + 1000 }) as unknown as Record<
        string,
        number
      >;
      expect([low[key], high[key]], key).toEqual([range.min, range.max]);
    }
    const long = settings.sanitizeSettings({ namingTemplate: 'x'.repeat(500) });
    expect(long.namingTemplate.length).toBe(settings.LIMITS.namingTemplate.maxLength);
  });
});
