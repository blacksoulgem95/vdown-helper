// Backlog helper.
//   node scripts/backlog.mjs set VDH-005 done      -> updates the task's front-matter and the README index
//   node scripts/backlog.mjs check <ID> [n,n,...]  -> ticks acceptance criteria (1-based) in a task; omit list to tick all
//   node scripts/backlog.mjs index                 -> regenerates the README index table from task front-matter
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(import.meta.dirname, '..', 'BACKLOG');
const STATUSES = ['todo', 'in-progress', 'blocked', 'done', 'wontfix'];

function taskFiles() {
  return readdirSync(dir)
    .filter((f) => /^VDH-\d+-.*\.md$/.test(f))
    .sort();
}
function front(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) throw new Error('missing front-matter');
  return Object.fromEntries(
    m[1].split('\n').map((l) => {
      const i = l.indexOf(':');
      return [
        l.slice(0, i).trim(),
        l
          .slice(i + 1)
          .replace(/\s+#.*$/, '')
          .trim(),
      ];
    }),
  );
}
function fileFor(id) {
  const f = taskFiles().find((x) => x.startsWith(`${id}-`));
  if (!f) throw new Error(`No task ${id}`);
  return resolve(dir, f);
}
function index() {
  const rows = taskFiles().map((f) => {
    const m = front(readFileSync(resolve(dir, f), 'utf8'));
    const deps = m.depends_on.replace(/[[\]]/g, '').trim() || '-';
    return `| [${m.id}](${f}) | ${m.title} | ${m.status} | ${m.priority} | ${m.area} | ${deps} |`;
  });
  const p = resolve(dir, 'README.md');
  const text = readFileSync(p, 'utf8');
  const head = text.slice(0, text.indexOf('| ID |'));
  writeFileSync(
    p,
    `${head}| ID | Title | Status | Priority | Area | Depends on |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`,
  );
}

const [cmd, id, arg] = process.argv.slice(2);
if (cmd === 'set') {
  if (!STATUSES.includes(arg)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  const p = fileFor(id);
  const t = readFileSync(p, 'utf8').replace(/^status:.*$/m, `status: ${arg}`);
  writeFileSync(p, t);
  index();
} else if (cmd === 'check') {
  const p = fileFor(id);
  let n = 0;
  const wanted = arg ? new Set(arg.split(',').map(Number)) : undefined;
  const t = readFileSync(p, 'utf8').replace(/^- \[( |x)\] /gm, (m) => {
    n++;
    return !wanted || wanted.has(n) ? '- [x] ' : m;
  });
  writeFileSync(p, t);
} else if (cmd === 'index') {
  index();
} else {
  console.error('usage: backlog.mjs set|check|index');
  process.exit(1);
}
