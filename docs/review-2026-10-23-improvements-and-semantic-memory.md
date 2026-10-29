# Kobe review (2026-10-23): improvements and Semantic Memory

Review of `main` at `21cf0bc1` on 2026-10-23: where the repo and runtime carry weight they do not
need, what else is worth improving, and a gap review of the v1.3 Semantic Memory spec (SM1–SM31)
and its tickets KOBE-376 to KOBE-413. Nothing was changed in the repo; every finding was verified in
code, in CI logs or in the built images. The working copy lives in Claude Docs; this file is the
snapshot kept with the code.

## Bloat and efficiency: the five biggest wins

Five changes remove most of the weight, and none of them touches product behaviour. The production
code itself is disciplined for its size; the bloat sits around it.

| Finding                                               | Measured                                                                                                                                                                                                                                                                                                                     | Fix                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The server image ships Next.js and the test toolchain | `kobe-server` image 1.17 GB, `/app` 676 MB of which `dist` is 10 MB. Inside: next 201 MB, @next/swc 93 MB, plus vitest, vite, happy-dom and drizzle-kit. The model-gateway image has none of these (`/app` 126 MB).                                                                                                          | better-auth lists next, vitest and drizzle-kit as optional peers; pnpm's default `dedupe-peer-dependents` resolves them from the workspace into the server deploy. Set `dedupePeerDependents: false` and `resolvePeersFromWorkspaceRoot: false` in pnpm-workspace.yaml, reinstall, commit the lockfile, rebuild. Expect about 300 MB off every server image. |
| Drizzle snapshots travel everywhere                   | `packages/db/drizzle/meta` is 59 MB: 178 snapshots of about 600 KB. The 25 largest blobs in the repo are all snapshots. `@kobe/db` publishes the folder, so it is in the image. The migrator reads only `_journal.json` and the SQL files.                                                                                   | Keep snapshots in git for `drizzle-kit check`; publish only SQL and journal; add the snapshot glob to `.dockerignore`.                                                                                                                                                                                                                                       |
| CI rebuilds and re-checks more than it needs          | Latest run on main: checks 468 s (unit tests 275, build 45, typecheck 32, format 26); db-server shards 352 s and 361 s; db-core 242 s. No Turbo remote cache, so three DB jobs rebuild what checks built. Sources are type-checked by `pnpm build`, again by `pnpm typecheck`, and the web app a third time by `next build`. | Turn on the Turbo remote cache; drop `^build` from `lint` (not type-aware); check each package once.                                                                                                                                                                                                                                                         |
| Every DB test file replays all 177 migrations         | 290 `*.db.test.ts` files. Measured on the dev Postgres: 1.9 s to create and migrate, 0.4 s to drop, per file. About 11 minutes of summed provisioning per run.                                                                                                                                                               | Migrate one template database per lane in `db-global-setup.ts` and clone it with `CREATE DATABASE … TEMPLATE` per file. The KOBE-482 lane work is the natural home.                                                                                                                                                                                          |
| Server-only protocol schemas reach the browser        | `@kobe/protocol` is imported from its root barrel in 105 web files and declares no `sideEffects: false`. A 487 KB client chunk carries sandbox-wire frame schemas such as `artifact.put`, `memory.put`, `web_search.query` and `trace.span`.                                                                                 | Add `"sideEffects": false`; move sandbox-wire and other server-only modules out of the root export; give the web subpath entries.                                                                                                                                                                                                                            |

Local disk: 62 sibling worktrees total 69 GB, and 274 branches are already merged into main with
worktrees still attached. Nothing was removed; `git worktree remove` on the merged ones recovers
most of it.

## Server hot path and background load

Eight database round trips run before any team-scoped handler, and about 37 timers poll per
replica whether or not anyone is using the site.

| Step             | Queries                                                                                         | Keep or change                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `requireSession` | better-auth session lookup; users joined with site roles; `site_settings` read of `require_2fa` | The user and role re-reads are a documented security choice. Cache the site setting with LISTEN/NOTIFY invalidation.      |
| `requireTeam`    | active team join; membership select                                                             | Merge into one query.                                                                                                     |
| `withTeam`       | BEGIN; `current_setting` probe; `set_config`                                                    | One invoker-rights SQL function, as the budget functions already do. With 471 call sites, one saved statement multiplies. |

- **Timers.** default-sync polls every 10 s and the skill-eval sweep every 5 s on every replica,
  even idle. The budgets monitor opens a `withTeam` transaction per team every 30 s. A job registry
  with jitter plus NOTIFY-driven wakeups would replace most polling; the deferred waker already
  exists.
- **One statement per item.** `retire-notify` inserts one notification row per user in a loop;
  `retention/orphans` checks legal hold per candidate inside a batch; the budgets sweep iterates
  all teams. Each is a single multi-row statement away from fixed.
- **MCP proxy.** Each tool call asks the server to decide, then asks again for the grant. Returning
  the grant inside the allow keeps the credential-after-allow rule and halves the hops.

## Code organisation

Sixteen non-test files exceed the repo's own 800-line cap, and a handful of helpers are copied
rather than shared.

| File                                           | Lines      |
| ---------------------------------------------- | ---------- |
| e2e/run.sh                                     | 3,606      |
| packages/db/src/audit/events.ts                | 2,375      |
| apps/web/lib/chat/testing/fake-kobe.ts         | 2,359      |
| services/server/src/sandbox-wire/connection.ts | 1,631      |
| services/server/src/runs/orchestrator.ts       | 1,382      |
| services/server/src/sandbox/provider.ts        | 1,195      |
| apps/web/lib/chat/thread-controller.ts         | 1,045      |
| services/sandbox-agent/src/threads/thread.ts   | 1,034      |
| services/sandbox-agent/src/workspace/sync.ts   | 1,022      |
| seven more                                     | 836 to 982 |

- **Oversized functions.** `createSandboxProvider` is one 837-line function. The orchestrator
  constructor is 159 lines. `ThreadController#afterClose` is 250 lines. `chat-app.tsx` holds 17
  `useEffect` hooks.
- **Composition root.** `services/server/src/index.ts` is a 710-line top-level script that starts
  about 15 timers inline and is the second most-changed file since September. A `startServer()`
  with a job registry would make start-up order and shutdown testable.
- **Two test layouts.** 185 server and 49 sandbox-agent test files sit flat in `src/` while module
  folders also hold tests. `fake-kobe.ts` is a hand-written replica of the server API used by about
  20 component tests, with 61 commits since September: every API change is paid twice and drift is
  silent.
- **Skills module.** 117 files with 50 flat at the top level; `rescan*`, `default-sync*`, `usage*`
  and `skill-install-*` want sub-folders.
- **Ledger.** `docs/ledger` is 350 per-ticket files in a public repo. Archiving closed phases trims
  clones and search noise.

| Duplicated helper                  | Copies | Note                                            |
| ---------------------------------- | ------ | ----------------------------------------------- |
| pgCode                             | 6      | verbatim                                        |
| actorOf                            | 4      | verbatim                                        |
| decodeCursor                       | 4      | same base64url JSON shape                       |
| readCapped                         | 3      | near-identical                                  |
| uuid param parse in routes         | 44     | plus 59 `if (!x.success) return invalidRequest` |
| raw `c.req.json().catch` in routes | 15     | bypasses the shared `parseBody`                 |

A shared `pg-errors.ts`, `cursor.ts` and a `param(c, name, schema)` helper would remove about 150
lines and one class of drift.

**Already in good shape:** lean dependency lists (server 26, web 34, db 5, protocol 2), only 12
`console.log` calls and all in CLI output, no `ts-ignore` in production code, every
`eslint-disable` is `no-control-regex`, test-to-source ratios of 0.6 to 1.2, generated files
prettier-ignored, mermaid loaded lazily, images non-root.

## Further improvements

These are outside the bloat review and each was verified in the repo or on GitHub.

- **Pi is four minor versions behind.** The sandbox pins `@earendil-works/pi-coding-agent` 1.0.0.
  Upstream shipped 1.1.0 through 1.4.0 between 2026-10-07 and 2026-10-21, with two "Breaking
  Changes" sections and a pinned fix for three brace-expansion advisories. Dependabot has opened 36
  PRs and none for Pi, so the `images/sandbox/pi` entry is not producing bumps. Suggested: an
  upgrade ticket plus a test that kobe-exec, kobe-policy and kobe-tools still bind to the extension
  API they expect.
- **Session tokens are symmetric.** Each proxy holds the HS256 key for its audience. A compromised
  MCP proxy could mint a token for any live sandbox and pull that user's connector grant through
  the internal `/grant` endpoint; the server's liveness and membership checks do not stop that.
  Signing with Ed25519 on the server and giving services only public keys closes it with no
  protocol change.
- **Service images are not scanned.** `publish.yml` builds six images with no Trivy step. Only the
  sandbox, orbit-eval and skill-scan workflows scan.
- **Traces but no metrics.** The telemetry package exports spans only. Queue depths, timer
  durations, token-exchange latency, budget sweeps and MCP decision latency have no numeric series
  to alert on.
- **Lint is not type-aware.** The flat config uses typescript-eslint `strict` without
  `projectService`, so floating and misused promises are not caught.
- **Two replicas, no spreading.** The chart has no PodDisruptionBudget or topology spread for the
  server and gateway, so both replicas can land on one node. Readiness probes are wired correctly
  through the helper.
- **SSO** is deferred by D7 and is not re-litigated here. When it comes, better-auth's OIDC plugin
  is the path.

**Credential handling, for the record.** The harness never receives user credentials. Pi holds
four short-lived session tokens (15 min, one key per audience). MCP keys and OAuth tokens are
envelope-encrypted per record and attached by the MCP proxy only after the server allows a specific
call; model provider keys live in Bifrost behind per-member virtual keys; the browser only ever
sees a masked hint. The one plaintext copy outside Postgres is in the proxy's memory for a single
upstream call.

## Semantic Memory v1.3: what the plan misses

The gating prerequisites (KOBE-274 to 276 and the Skills Phase A migrations 307, 308, 311, 318) are
all done in Hadron, so only promotion blocks a start. The spec is strong on governance and
injection safety; the gaps are in the data layer and in what the tickets leave out.

- **The item schema cannot pass the tenancy checks as written (SMA1, SMA5, SMA7).** SMA1 puts team,
  portable and Site rows in one `semantic_memory_items` table with a nullable `team_id`. The
  catalog test requires `team_id uuid NOT NULL` on every team table, and FORCE RLS with the
  canonical policy hides null-team rows inside `withTeam`. `memory_curators` has the same shape,
  and `run_memory_items` cannot carry a composite foreign key to a mixed table. Split it: team
  tables under RLS, a portable table shaped like `personal_skills`, and a Site table shaped like
  `site_settings`.
- **The GIN indexes will not be used for team rows.** Migration `0013_thread_search.sql` documents
  why: under FORCE RLS the planner only pushes leakproof operators into an index, and `@@` and `%`
  are not. With at most 1,000 items per team a team-filtered scan is well inside the 50 ms target.
  Keep GIN only on the Site and portable tables.
- **A Site FTS language setting conflicts with a stored tsvector (SMA6).** A generated column needs
  a constant `regconfig`, which is why thread search is fixed to English. Fix the language or
  compute the vector at query time, and cut the setting.
- **The block will bust provider prompt caches (SMA7, SMA8).** Memory text is added to the system
  prompt per run. Today's Notes index changes only when memory is written; the new block is
  re-selected on every user message, so the cacheable prefix changes every turn of a long thread.
  Stickiness helps but does not fix it.

| Spec item with no ticket                                                         | Where it falls                              | Suggested home                      |
| -------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| Retention sweeps for passes, candidates, dismissals and proposals (SM28)         | SMA11 is Phase A, before those tables exist | new Phase B ticket                  |
| 80% scope-limit notification to curators (SM22)                                  | not ticketed                                | SMA3 or SMB9                        |
| Import "check with the learning model" (SM21)                                    | deferred to Phase B, never ticketed         | new B ticket, or drop from the spec |
| User and portable items in the D18 personal export                               | not ticketed                                | SMA3 or SMA11                       |
| Docs: install.md, backup-restore.md, audit-log.md (asserted by `events.test.ts`) | SMA2 registers names only                   | each phase gate checklist           |
| Context viewer section kind for "What Kobe knows" (protocol knows `memory` only) | SMA8                                        | add to SMA8 touches                 |
| Site-wide legal hold (holds are per team or per user today)                      | SM28, SMA11                                 | its own migration, land alone       |
| Site-level break-glass grant (`break_glass_grants.team_id` is NOT NULL today)    | SMA11 says "if needed"                      | a definite migration ticket         |
| Notification digest and 7-day reminders (no such machinery today)                | SMB9                                        | call out the scope                  |
| One running pass per thread across two server replicas                           | SMB5                                        | partial unique index on passes      |

With those added, the serial migration count is six or seven: 376, 389, 402, the break-glass grant,
the Site-wide hold, possibly a team settings column for 381, and 409 only if vectors are earned.

## Semantic Memory v1.3: changes proposed to the plan

Ten changes, none of which reopens a decision in SM1 to SM31; each tightens how a decision is
carried out.

1. **Freeze the selected set per thread.** Select on the first run, then only append new matches
   within a thread. This keeps the system prompt stable for provider caching and stops the memory
   set flickering between turns. Measure cache hit rate at Gate A.
2. **Learning model default.** Falling back to the thread's model means a fast chat model extracts
   memories. Default to a Site alias and show the model in the button tooltip.
3. **Drop tool outputs from the extractor input by default.** They can only yield inferred
   candidates, and they are the main injection vector and token cost. Keep an opt-in for re-scans.
4. **Dismissals per person, not per thread.** Otherwise a dismissed candidate returns in the next
   thread.
5. **Give facts and decisions an `as_of` date** shown in the block ("as of Oct 2026"). Staleness by
   age matters more than staleness by retrieval for those kinds.
6. **Near-duplicate check on every create**, not only imports: trigram similarity above 0.8 with a
   "looks like an existing memory" prompt.
7. **Show Policy text to team admins**, not just a count. Policy is an instruction channel exempt
   from lint and from the team opt-out, so transparency matters.
8. **Normalize quotes before verifying them.** Exact substring matching will drop real quotes over
   whitespace and smart quotes. Compare after normalizing whitespace, case and quote characters.
9. **Per-agent "uses Memories" switch.** Agents have no memory setting today, and a strict
   extraction agent should be able to run without them.
10. **Grow the eval and probe the non-RLS reads.** Thirty transcripts cannot support a 0.8
    precision claim; aim for 100 over Phase B and report per kind, keeping the adversarial hard
    fail. SMC5 probes Site proposals only; every server path reading Site or portable rows should
    get the same test for switch and membership checks.
