import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bumpVersion,
  compare,
  detectBump,
  latestReleased,
  nextVersion,
  parseVersion,
} from '../scripts/lib/version.ts';

describe('parseVersion / latestReleased', () => {
  it('accepts x.y.z only (Chrome manifests and release tags)', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('v10.0.5')).toEqual({ major: 10, minor: 0, patch: 5 });
    for (const bad of ['1.2', '1.2.3.4', '1.2.3-beta', 'x', '', '1.2.-3'])
      expect(parseVersion(bad)).toBeUndefined();
  });
  it('compares numerically, not as text (0.10.0 > 0.9.0)', () => {
    expect(compare(parseVersion('0.10.0')!, parseVersion('0.9.0')!)).toBeGreaterThan(0);
  });
  it('picks the highest vX.Y.Z tag and ignores everything else', () => {
    const tags = ['v0.9.0', 'v0.10.0', 'v0.2.1', 'latest', 'v1.0.0-rc1', '0.99.0', 'release-5'];
    expect(latestReleased(tags)).toEqual({ major: 0, minor: 10, patch: 0 });
    expect(latestReleased(['nightly', 'v1'])).toBeUndefined();
    expect(latestReleased([])).toBeUndefined();
  });
});

describe('detectBump', () => {
  it.each([
    [['fix typo'], 'patch'],
    [[], 'patch'],
    [['add thing #minor'], 'minor'],
    [['[minor] add thing'], 'minor'],
    [['rework #major', 'also #minor'], 'major'],
    [['[MAJOR] breaking'], 'major'],
    [['talking about a majority vote'], 'patch'],
    [['#minority'], 'patch'],
  ] as const)('%j -> %s', (messages, bump) => {
    expect(detectBump([...messages])).toBe(bump);
  });
  it('bumps and resets lower parts', () => {
    const v = parseVersion('1.4.7')!;
    expect(bumpVersion(v, 'patch')).toEqual({ major: 1, minor: 4, patch: 8 });
    expect(bumpVersion(v, 'minor')).toEqual({ major: 1, minor: 5, patch: 0 });
    expect(bumpVersion(v, 'major')).toEqual({ major: 2, minor: 0, patch: 0 });
  });
});

describe('nextVersion', () => {
  const base = { tags: [] as string[], packageVersion: '0.1.0', messages: [] as string[] };
  it('first release uses package.json', () => {
    expect(nextVersion(base)).toEqual({ version: '0.1.0', reason: 'initial' });
    expect(nextVersion({ ...base, packageVersion: '1.0.0', tags: ['unrelated'] }).version).toBe('1.0.0');
  });
  it('patch by default', () => {
    expect(nextVersion({ ...base, tags: ['v0.1.0'], messages: ['fix'] })).toEqual({
      version: '0.1.1',
      reason: 'patch',
      previous: '0.1.0',
    });
  });
  it('minor / major from commit messages, reset lower parts', () => {
    expect(nextVersion({ ...base, tags: ['v0.1.5'], messages: ['x #minor'] }).version).toBe('0.2.0');
    expect(nextVersion({ ...base, tags: ['v0.1.5'], messages: ['x #major'] }).version).toBe('1.0.0');
  });
  it('an explicit choice (manual run) beats the commit messages', () => {
    expect(nextVersion({ ...base, tags: ['v0.1.5'], messages: ['x #major'], forced: 'patch' }).version).toBe(
      '0.1.6',
    );
    expect(nextVersion({ ...base, tags: ['v0.1.5'], forced: 'minor' }).version).toBe('0.2.0');
  });
  it('a human can jump ahead through package.json, never backwards', () => {
    expect(nextVersion({ ...base, tags: ['v0.1.5'], packageVersion: '0.4.0' })).toMatchObject({
      version: '0.4.0',
      reason: 'package.json',
    });
    expect(nextVersion({ ...base, tags: ['v0.7.0'], packageVersion: '0.1.0' }).version).toBe('0.7.1');
    // package.json equal to the next patch is just that patch
    expect(nextVersion({ ...base, tags: ['v0.1.0'], packageVersion: '0.1.1' }).reason).toBe('patch');
  });
  it('rejects a broken package.json version', () => {
    expect(() => nextVersion({ ...base, packageVersion: 'one' })).toThrow(/x\.y\.z/);
  });
});

describe('scripts/next-version.mjs against a real git repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vdh-version-'));
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  const run = (env: Record<string, string> = {}) => {
    const out = execFileSync('node', [resolve(import.meta.dirname, '../scripts/next-version.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, VDH_REPO_ROOT: dir, ...env },
    });
    return Object.fromEntries(
      out
        .trim()
        .split('\n')
        .map((l) => l.split('=') as [string, string]),
    );
  };
  const commit = (message: string) => git('commit', '--allow-empty', '-m', message);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('walks through a realistic release history', () => {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    git('add', '.');
    commit('first');

    expect(run()).toMatchObject({ version: '0.1.0', reason: 'initial', tagged: 'false' });

    git('tag', 'v0.1.0');
    expect(run()).toMatchObject({ version: '0.1.0', reason: 'already-tagged', tagged: 'true' }); // re-run

    commit('fix a bug');
    expect(run()).toMatchObject({ version: '0.1.1', reason: 'patch', previous: '0.1.0', tagged: 'false' });

    commit('add a feature #minor');
    commit('another fix');
    expect(run()).toMatchObject({ version: '0.2.0', reason: 'minor' });
    expect(run({ BUMP: 'patch' })).toMatchObject({ version: '0.1.1', reason: 'patch' });
    expect(run({ BUMP: 'nonsense' })).toMatchObject({ version: '0.2.0' });

    git('tag', 'v0.2.0');
    commit('docs only');
    expect(run()).toMatchObject({ version: '0.2.1', previous: '0.2.0' });

    // an old #major in already released history must not bump again
    commit('big change #major');
    git('tag', 'v1.0.0');
    commit('later fix');
    expect(run()).toMatchObject({ version: '1.0.1', reason: 'patch' });
  });
});
