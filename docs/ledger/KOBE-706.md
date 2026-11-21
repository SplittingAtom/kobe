# KOBE-706: sandbox-wire/connection.ts: one gated-frame helper for the tool frames, handlers split out

- **Status:** in review (group 64, branch `group-64-sandbox-wire-splits`)
- **Branch / worktree:** `group-64-sandbox-wire-splits` in `../Kobe-g64`
- **Depends on:** none (KOBE-707 follows in the same directory)

## Plan

1. Characterization tests first, against the old code: every tool frame kind refused at every
   gate stage never reaches its action (`tool-frame-gate.test.ts`, snapshot of every answer and
   audit). Checked by removing single stages for single kinds (capability, run check, allowance,
   in-flight cap): each removal fails tests.
2. `gated-frame.ts`: `runGatedToolFrame` runs the gate once, in the old order; each kind declares a
   `ToolFrameSpec` (capabilities, allowance mode, refusal answers, action).
3. Move the handlers and the rest of the connection's frame code out over narrow ports.

## Decisions

- **Ten tool frames, not seven.** The review listed seven handlers; `memory.read`, `memory.show`
  and `file.open` run the same gate, so all ten go through the helper. Tool frames are defined by
  type: every sandbox frame with a `tool_call_id`, except `policy.check` (the decision itself) and
  the legacy `web_search.query` (answered unavailable, does nothing).
- **Gate enforced by types:** `ToolFrameSpecs` is a mapped type over those kinds, so a new tool frame
  does not compile until it has a spec; `#dispatch` sends tool frames only to `runToolFrame`, and
  in the switch after it `frame` is narrowed so a `case` for a tool frame does not compile; a spec's
  `act` needs a `GatePassed`, whose constructor is private and which only the gate makes (nominal
  through a `#` field, so a look-alike object does not type-check). `gated-frame.test.ts` pins the
  kind list and the proof with `expectTypeOf` / `@ts-expect-error`.
- **Order unchanged:** capability (+ notebook storage) → kind's pre-run check (skill-eval refusal of
  `file.edit_propose` / `file.open`) → `#checkToolRun` (violation: nothing more sent) → allowance
  (`check` or `consume`, same tool names) → kind's post-allowance check (skill drafts configured)
  → in-flight cap → action. `violate()` vs `send()` order is untouched (`RunChecks` is the old code).
- **Error paths kept:** each action keeps its own `.catch`; a synchronous throw still propagates; the
  in-flight slot frees when the action's promise settles (memory: once the sandbox is answered, as
  before). The only reordering is that artifact/file/draft slots now free one microtask after the
  answer instead of just before it, which no inbound frame (a macrotask) can observe.
- `project.commit`'s `ruleAllowed` now takes the frame (the connection object is per connection,
  no longer per frame).
- `admitPiVersion` / `supportedPiVersion` moved to `pi-version.ts` and are re-exported from
  `connection.ts` (`pi-version.test.ts` unchanged).

## Layout (lines)

`connection.ts` 1837 → 798: lifecycle, rate/size limits, dispatch, leases, hello, timers.
New: `gated-frame.ts` 185, `connection-limits.ts` 103, `leases.ts` 58, `run-checks.ts` 88,
`session-expiry.ts` 87, `pi-version.ts` 42, `frames/` (`port` 15, `tool-frames` 86,
`artifacts-files` 196, `memory` 207, `policy` 102, `results` 86, `hello` 82, `ingest` 70,
`run-end` 51, `trace-spans` 47, `ui-request` 40, `notebook-output` 35, `workspace-sync` 69).
`file-edit-propose.ts`, `file-open.ts`, `notebook-run.ts`, `skill-draft-save.ts`,
`project-commit.ts` export a spec instead of doing the gate themselves.

## Docs

No `docs/guide/` change: a pure refactor; nothing a member, admin or in-sandbox agent sees or can
do changes (same frames, answers, messages, audits).

## Open questions (for Chris or the coordinator)

- ac-4 (Opus security review of the diff) is the coordinator's.

## Evidence (acceptance criteria → test or command output)

- ac-1: `src/sandbox-wire/gated-frame.test.ts` (capability missing, run ended/violation, verdict
  refusals, cap reached and slot freed, action throws, one refusal per frame) and
  `src/sandbox-wire/tool-frame-gate.test.ts` (77 cases over the real connection, written and
  green before the refactor, unchanged snapshots after).
- ac-2: `wc -l services/server/src/sandbox-wire/connection.ts` → 798.
- ac-3: existing tests unchanged; results of `pnpm verify` and `pnpm --filter @kobe/server test:db`
  in the group's final report.
