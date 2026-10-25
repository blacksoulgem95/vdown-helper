# Backlog rule

Work on this project is tracked as Markdown tasks in `BACKLOG/`. This rule always applies.

## Format

- One file per task: `BACKLOG/VDH-NNN-short-slug.md` (NNN is zero-padded and never reused).
- YAML front-matter at the top:

  ```yaml
  ---
  id: VDH-005
  title: HLS playlist parser
  status: todo          # todo | in-progress | blocked | done | wontfix
  priority: P1          # P0 critical, P1 high, P2 normal, P3 low
  area: lib             # lib | background | content | ui | build | docs | test | security
  depends_on: [VDH-004]
  ---
  ```

- Body sections: `## Description`, `## Acceptance criteria` (checkbox list), `## Notes`.
- `BACKLOG/README.md` holds the status legend and an index table. Keep it in sync with the files.

## Statuses

| Status | Meaning |
|---|---|
| `todo` | Not started |
| `in-progress` | Being worked on right now (keep this to a minimum) |
| `blocked` | Cannot proceed; say why and on what in `## Notes` |
| `done` | All acceptance criteria met **and verified** |
| `wontfix` | Deliberately dropped; say why in `## Notes` |

## Rules

1. Before starting work, find or create the matching task and set `status: in-progress`.
2. New or discovered work gets its own task file. Do not do untracked work.
3. Tick acceptance-criteria checkboxes as they are verified, not before.
4. Set `done` only after the relevant tests/verification have actually run and passed. Never mark
   a task `done` while the feature is simulated, stubbed, or unverified; use `blocked` or leave it
   `in-progress` and write what is missing in `## Notes`.
5. Update the index in `BACKLOG/README.md` in the same commit as the status change.
6. Commit subjects reference the task ID(s): `VDH-009: download queue state machine`.
