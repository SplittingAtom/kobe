# Gate C: Organization and composer verification (KOBE-226)

Evidence for the v1.1 Phase C gate (Conversational Enhancements CE18–CE23): _a title appears after
the first run and a rename stops auto-titling; pin, archive and move reflect in the rail; a second
member opens a team-shared thread read-only and forks it; an @file mention reaches the prompt as a
sandbox path and the agent reads it; every registry action runs from the palette; on k3d in CI and
on the real cluster._ Phase C is KOBE-219 (auto-titles), 220 (pin, archive, move), 221 (share
scope), 222 (starters and follow-ups), 223 (@file), 224 (`/` menu), 225 (palette and shortcuts),
plus KOBE-301 (status cues) and KOBE-302 (fixes) from the same group.

**Decision (Chris, 2026-10-16, as Gate B decision C):** the palette is proven by its component
tests in CI plus the `e2e/browser` Playwright palette spec run on gate1 as recorded evidence. There
is no browser job in CI. The CI k3d e2e (`e2e/run.sh`) adds API cases for auto-titles, pin/archive/
move and team share + revoke; the project share (KOBE-164) and @file (KOBE-223) were already there.

## Running it

```bash
# k3d (CI): every e2e shard runs on the PR's head commit and again in the merge queue
KOBE_E2E_SHARD=suite e2e/run.sh                              # shard `suite`
KOBE_E2E_SHARD=suite KOBE_E2E_TOOL_EXECUTOR=1 e2e/run.sh     # shard `executor`

# gate1 (the real cluster), after the G4 deploy: the browser specs, from e2e/browser
KOBE_BASE_URL=<gate1 URL> KOBE_USER=<owner, a team admin> KOBE_PW=<password> \
KOBE_USER2=<second member of the team> KOBE_PW2=<password> \
  npx playwright test command-palette file-mentions follow-ups slash-menu status-cues share organize auto-title
```

The browser suite's variables, prerequisites (a second password member for `share`; a team admin
with every budget under 80 % for `follow-ups`) and its Playwright container are in
[`e2e/browser/README.md`](../../e2e/browser/README.md).

## Verdict

_Filled in after the G4 PR's CI and the gate1 deploy._

| Criterion                                                  | k3d (CI, fake upstream model)   | Real cluster (gate1, real model)    |
| ---------------------------------------------------------- | ------------------------------- | ----------------------------------- |
| ac-1 Titles, pin/archive/move and sharing proven in CI e2e | pending: G4 PR CI               | browser specs, run after G4 deploy  |
| ac-2 @file and the palette on k3d and on the real cluster  | @file: e2e; palette: components | pending: browser specs after deploy |
| ac-3 Gate 1, 2, A and B shards green on the same commit    | pending: G4 PR CI               | n/a                                 |

## ac-1 Titles, pin/archive/move and sharing in CI e2e

All in `e2e/run.sh`, shards `suite` and `executor`, after the KOBE-284 fork section. The checks
print as `ok <name>` / `FAIL <name>`.

### `==> auto-titles and follow-ups (KOBE-219, KOBE-222)`

The title and follow-up calls are the server's own: server-call token → model-gateway shim →
Bifrost → the fake upstream. The fake model echoes the last user text, so it answers the title
prompt with `fake-openai: First message: …`; the normalised title is its first line,
`fake-openai: First message`. The fallback title (the prompt's first line, used only when no call
is made or the last one failed) would be the prompt itself, so the check tells the two apart. No
change to the fake model was needed.

| Check (`auto-titles:` / `follow-ups:` …)                                           | Proves                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| a team admin turns the team switch on                                              | `PUT /v1/team/settings` (KOBE-222)                             |
| a thread created without a title starts untitled                                   | `title` NULL, `title_locked` false                             |
| its run.completed announces the title and follow-up calls                          | `epilogue` has `title` and `followups`                         |
| the thread is titled from the model's reply through the gateway (not the fallback) | the generated title is saved, unlocked                         |
| thread.updated and thread.suggestions follow run.completed                         | both epilogue events are appended to the run                   |
| the title event carries the saved title                                            | `thread.updated.title`                                         |
| the calls are the run's title and followups usage rows, without a sandbox          | `run_usage` `kind = title` / `followups`, 200, no `sandbox_id` |
| the chips are the fake model's suggestions for the last exchange                   | `thread.suggestions` parsed from the reply (lead-ins dropped)  |
| the owner renames the thread (200); a rename locks the title                       | `title_locked` true                                            |
| a run after the rename … announces follow-ups but no title call                    | no `title` in the epilogue                                     |
| … its follow-ups arrive, with no title event; no title call was made               | no `thread.updated`, only a `followups` usage row              |
| the renamed thread is never re-titled                                              | title unchanged after the run                                  |
| a team admin turns the team switch off; … announces no server call at all          | switch off: no `followups`, no event, no usage row             |

### `==> organize and team sharing (KOBE-220, KOBE-221)`

One node script in the server pod (`ORG_JS`) signs in the Owner (a team admin) and the reader (a
plain member) and works on the titled thread above.

| Check (`organize:` / `share:` …)                                               | Proves                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| the owner pins the thread; it is in Pinned, not in the activity list           | `POST …/pin`, `GET /v1/threads/pinned`, rail lists                               |
| another member can't pin it (404)                                              | owner only; a private thread stays invisible                                     |
| unpin; back in the activity list                                               | `POST …/unpin`                                                                   |
| archiving a pinned thread archives and unpins it; in Archived only             | `POST …/archive`, `GET /v1/threads/archived`                                     |
| an archived thread can't be pinned (409 `thread_archived`)                     | Pinned and Archived are exclusive                                                |
| unarchive; back in the activity list                                           | `POST …/unarchive`                                                               |
| the owner moves the thread into the project (listed there)                     | `POST …/move {project_id}`                                                       |
| shared to the project, the member reads it; the member can't move it (403)     | project share; a reader never writes                                             |
| moved out of the project, the thread is private again; the member gets 404     | a move ends the project share                                                    |
| both moves are audited                                                         | `thread.moved` ×2                                                                |
| moving a thread with an active run is refused (409 `thread_busy`)              | the fake holds back a `kobe-slow-start` answer; Stop, then the move goes through |
| the owner shares the thread with the team                                      | `POST …/share {visibility: team}`                                                |
| another member opens it read-only, with the conversation; Shared with me       | `read_only: true`, `GET /v1/threads/shared`                                      |
| the member can't post to it / change its sharing (403 `read_only`)             | team readers never write                                                         |
| the member forks it into a private thread of their own; invisible to the owner | fork with provenance                                                             |
| the owner revokes; the member gets 404 and no longer lists it                  | revocation is immediate on reads                                                 |
| the team share and revoke are audited                                          | `thread.sharing_changed` (`team`, then `from: team`)                             |
| the Owner is a team admin; the member's private thread is 404 for them         | a team admin gets nothing extra                                                  |
| the team admin reads the shared one read-only; only it is in Shared with me    | sharing, not the role, grants the read                                           |
| the team admin can't post to it either (403 `read_only`)                       |                                                                                  |

The project share itself (share, read-only, fork, unshare, 404) stays covered by `==> projects
(KOBE-164)`. How the rail renders these lists is covered by the web component tests
(`thread-organize.test.tsx`, `thread-share.test.tsx`, `lib/chat/thread-groups.test.ts`,
`thread-list-adapter.test.ts`) in the `checks` job, and on gate1 by `organize.spec.ts`,
`share.spec.ts` and `auto-title.spec.ts`.

## ac-2 @file and the palette, on k3d and on the real cluster

- **@file on k3d:** `==> uploads (KOBE-146)`, the KOBE-223 `mentions:` checks: "a message with an
  @file mention starts a run (201)", "the stored prompt names the absolute sandbox path, not the
  marker" (`runs.input` has `/workspace/uploads/…`), "the agent read the mentioned file by that
  path" (the real sandbox's `cat` output comes back), bad mentions "refused (422)", "no refused
  mention left a run".
- **Palette in CI (component tests, `checks` job):** `apps/web/components/shell/command-palette.test.tsx`
  (every registered action listed with its key or why it can't run; run by any of its words;
  blocked actions say why and run nothing; choices such as Regenerate with; thread and file
  results; a reader of a shared thread can't run the owner's actions), `apps/web/lib/shell/palette.test.ts`,
  `components/shell/shortcut-keys.test.tsx` (the twelve shortcuts), and for the `/` menu
  `components/chat/slash-menu.test.tsx`.
- **On gate1, run after the G4 deploy** (recorded evidence, not CI):

  | Spec                      | What it shows                                                                 |
  | ------------------------- | ----------------------------------------------------------------------------- |
  | `command-palette.spec.ts` | the palette runs an action and opens a thread; `?` lists the twelve shortcuts |
  | `file-mentions.spec.ts`   | pick a workspace file with @; the agent reads it by its absolute path         |
  | `follow-ups.spec.ts`      | switch on, chips after the answer, a chip sends, switch off again             |
  | `slash-menu.spec.ts`      | `/fork` runs the Fork action; an unknown `/hello` is sent as text             |
  | `status-cues.spec.ts`     | Running badge and the rail's dot, also from another thread; reduced motion    |
  | `share.spec.ts`           | share with the team, read and fork as another member, then revoke             |
  | `organize.spec.ts`        | pin, archive and move to project, in the rail and after a reload              |
  | `auto-title.spec.ts`      | a new thread gets its title after the first answer, in the rail and header    |

## ac-3 Gate 1, 2, A and B shards on the same commit

One commit (the G4 PR's head, then its merge-queue commit) must pass every required check:
`checks` (lint, types, unit and component tests, the palette and `/` menu tests among them), `db`,
`images`, and `k3d`, which passes only when every e2e shard passed. Gate A has no shard of its
own: it was signed off on gate1 browser measurements (2026-10-14), and its web component tests run
in `checks`.

| Shard        | Gate evidence it carries                                      |
| ------------ | ------------------------------------------------------------- |
| `gate1`      | Gate 1 (`e2e/gate1.sh`, [gate-1.md](gate-1.md))               |
| `gate2`      | Gate 2 (`e2e/gate2.sh`, [gate-2.md](gate-2.md))               |
| `suite`      | Gate B (compaction, fork at a message), Gate C ac-1 and @file |
| `executor`   | the same `suite` with the tool executor on                    |
| `cold-start` | wake and hibernate trials                                     |

## Results

_To be recorded: the G4 PR's e2e run (link, commit), the merge-queue run, and the gate1 browser run
(commit deployed, specs passed, date)._
