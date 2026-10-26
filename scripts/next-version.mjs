// Prints the version the release pipeline should publish next, as key=value lines for $GITHUB_OUTPUT:
//   version=0.1.1  reason=patch  previous=0.1.0  tagged=false
// If the checked-out commit already carries a release tag (a re-run), that version is reported with tagged=true and
// nothing new should be released. Inputs: git tags and history, package.json, and optionally BUMP=patch|minor|major.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { latestReleased, nextVersion, format, parseVersion } from './lib/version.ts';

// VDH_REPO_ROOT lets the tests point this at a throw-away repository.
const root = process.env.VDH_REPO_ROOT ?? resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const lines = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const tags = lines(git('tag', '--list'));

// Re-run on a commit that was already released: report that release instead of making a new one.
const atHead = lines(git('tag', '--points-at', 'HEAD')).filter((t) => parseVersion(t) && /^v/.test(t));
if (atHead.length > 0) {
  const v = latestReleased(atHead);
  console.log(`version=${format(v)}\nreason=already-tagged\ntagged=true`);
  process.exit(0);
}

const latest = latestReleased(tags);
const range = latest ? `v${format(latest)}..HEAD` : 'HEAD';
const messages = lines(git('log', '--format=%B%x00', range))
  .join('\n')
  .split('\u0000')
  .map((m) => m.trim())
  .filter(Boolean);

const forced = ['patch', 'minor', 'major'].includes(process.env.BUMP ?? '') ? process.env.BUMP : undefined;
const next = nextVersion({ tags, packageVersion: pkg.version, messages, ...(forced ? { forced } : {}) });
console.log(
  `version=${next.version}\nreason=${next.reason}\ntagged=false${next.previous ? `\nprevious=${next.previous}` : ''}`,
);
