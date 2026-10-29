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

/** `{ $bytes: [...] }` arguments are Uint8Arrays. */
const revive = (a: unknown): unknown =>
  a && typeof a === 'object' && '$bytes' in a ? Uint8Array.from((a as { $bytes: number[] }).$bytes) : a;

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
};

function cases(file: string): Case[] {
  return readFileSync(resolve(__dirname, '../core/fixtures/golden', file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Case);
}

afterEach(() => vi.useRealTimers());

function replay(file: string, min: number): void {
  const all = cases(file);
  it('has the recorded cases', () => expect(all.length).toBeGreaterThan(min));
  it('gives the same results as the TypeScript implementation did', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const c of all) {
      const fn = run[c.fn] as ((...a: unknown[]) => unknown) | undefined;
      if (!fn) throw new Error(`no export for ${c.fn}`);
      if (c.today) vi.setSystemTime(new Date(`${c.today}T12:00:00Z`));
      const args = c.args.map(revive);
      const what = `${c.fn}(${JSON.stringify(c.args).slice(0, 200)})`;
      if (c.throws !== undefined) expect(() => fn(...args), what).toThrow(c.throws);
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
