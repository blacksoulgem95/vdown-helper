// Pure version logic for the release pipeline (kept free of I/O so it can be unit-tested).
// Run by Node's built-in TypeScript support, so: no enums, no parameter properties.

export type Bump = 'patch' | 'minor' | 'major';

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export interface NextVersion {
  version: string;
  /** Why this version was chosen. */
  reason: 'initial' | Bump | 'package.json';
  /** The latest released version it follows, if any. */
  previous?: string;
}

const STRICT = /^(\d+)\.(\d+)\.(\d+)$/;

/** Chrome accepts 1-4 dot-separated integers; releases use plain x.y.z only. */
export function parseVersion(text: string): Semver | undefined {
  const m = STRICT.exec(text.trim().replace(/^v/, ''));
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export const format = (v: Semver): string => `${v.major}.${v.minor}.${v.patch}`;

export function compare(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** Highest x.y.z among tags named vX.Y.Z; other tags are ignored. */
export function latestReleased(tags: string[]): Semver | undefined {
  let best: Semver | undefined;
  for (const t of tags) {
    if (!/^v\d+\.\d+\.\d+$/.test(t.trim())) continue;
    const v = parseVersion(t);
    if (v && (!best || compare(v, best) > 0)) best = v;
  }
  return best;
}

/**
 * A commit raises the bump with `#major` / `#minor` on a line of its own, or `[major]` / `[minor]` in its subject (first
 * line); patch otherwise. Text that merely mentions the tokens (for example a message describing this rule) does not
 * count: that is how 1.0.0 was once published by accident.
 */
export function detectBump(messages: string[]): Bump {
  const says = (bump: 'major' | 'minor') =>
    messages.some((m) => {
      const lines = m.split(/\r?\n/).map((l) => l.trim().toLowerCase());
      return lines.includes(`#${bump}`) || (lines[0] ?? '').includes(`[${bump}]`);
    });
  if (says('major')) return 'major';
  if (says('minor')) return 'minor';
  return 'patch';
}

export function bumpVersion(v: Semver, bump: Bump): Semver {
  if (bump === 'major') return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

export interface NextVersionInput {
  /** All tag names in the repository. */
  tags: string[];
  /** The version in package.json: the first release, and a floor for later ones. */
  packageVersion: string;
  /** Commit messages since the latest release. */
  messages: string[];
  /** Explicit choice (manual workflow run); overrides what the commit messages say. */
  forced?: Bump;
}

/**
 * - no release yet            -> package.json's version (the first release)
 * - otherwise                 -> latest release + bump (patch unless #minor/#major or forced)
 * - package.json ahead of that -> package.json's version wins, so a human can still jump versions
 */
export function nextVersion(input: NextVersionInput): NextVersion {
  const pkg = parseVersion(input.packageVersion);
  if (!pkg) throw new Error(`package.json version "${input.packageVersion}" is not x.y.z`);
  const latest = latestReleased(input.tags);
  if (!latest) return { version: format(pkg), reason: 'initial' };
  const bump = input.forced ?? detectBump(input.messages);
  const candidate = bumpVersion(latest, bump);
  if (compare(pkg, candidate) > 0)
    return { version: format(pkg), reason: 'package.json', previous: format(latest) };
  return { version: format(candidate), reason: bump, previous: format(latest) };
}
