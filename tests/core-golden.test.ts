// The Rust core, as the extension runs it (wasm), against the golden fixtures recorded from the former TypeScript
// implementation. `cargo test` replays the same files natively (core/tests/golden.rs).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyPlaylist, parseHls } from '@/lib/hls/parser';
import { parseAttributes } from '@/lib/hls/attributes';
import { decodeEntities, parseXml } from '@/lib/xml';
import * as dash from '@/lib/dash/parser';
import { dashRef, parseDashRef } from '@/lib/dash/ref';
import { dashResource, mediaPlaylistVerdict } from '@/lib/analyze';
import { inspectDashRepresentation, inspectMediaPlaylist, originsOf, sampleByOrigin } from '@/lib/inspect';

interface Case {
  fn: string;
  args: unknown[];
  result?: unknown;
  throws?: string;
}

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
};

function cases(file: string): Case[] {
  return readFileSync(resolve(__dirname, '../core/fixtures/golden', file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Case);
}

function replay(file: string, min: number): void {
  const all = cases(file);
  it('has the recorded cases', () => expect(all.length).toBeGreaterThan(min));
  it('gives the same results as the TypeScript implementation did', () => {
    for (const c of all) {
      const fn = run[c.fn] as ((...a: unknown[]) => unknown) | undefined;
      if (!fn) throw new Error(`no export for ${c.fn}`);
      const what = `${c.fn}(${JSON.stringify(c.args).slice(0, 200)})`;
      if (c.throws !== undefined) expect(() => fn(...c.args), what).toThrow(c.throws);
      else expect(fn(...c.args), what).toStrictEqual(c.result);
    }
  });
}

describe('golden: hls', () => replay('hls.jsonl', 400));
describe('golden: dash and xml', () => replay('dash.jsonl', 500));
describe('golden: verdicts and inspections', () => replay('analyze.jsonl', 150));
