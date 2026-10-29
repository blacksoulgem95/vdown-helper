// The E2E fixture servers for other test suites (the desktop engine's integration tests): prints one JSON line with
// the base URLs, then serves until stdin closes or the process is stopped.
import { join } from 'node:path';
import { ensureFixtures } from './fixtures.mjs';
import { startServers } from './server.mjs';

const here = import.meta.dirname;
const fixtures = join(here, '.tmp/fixtures');
ensureFixtures(fixtures);
const s = await startServers(fixtures, join(here, 'pages'));
process.stdout.write(`${JSON.stringify({ a: s.a, b: s.b, c: s.c, d: s.d, root: fixtures })}\n`);
const stop = () => s.close().then(() => process.exit(0));
process.stdin.on('end', stop);
process.stdin.resume();
process.on('SIGTERM', stop);
