# KOBE-440: MA-6 Rail launcher and app cards (web, server, protocol, sandbox-agent)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

**Renumbered by db:rebase (2026-10-19, on main 05a92778):** the generated migrations are one, 0153_mcp_apps (old 0152, 0153, 0155, 0156, 0157, 0159, 0162); the custom ones keep their SQL: 0154 approved backfill (old 0154), 0155 RLS and legal hold (old 0158), 0156 run-end discard (old 0160), 0157 hold lock first (old 0161). Numbers below are the new ones.

Group MCP Apps (`group-ma-apps`), after KOBE-439. Spec `docs/specs/mcp-apps-host.md` MA3, MA8,
MA11 (amended), §6. Merged origin/main (G10 `aa2b5a14`) first. Nothing pushed; Hadron untouched.

## Commits (`fa9caf10..`)

- `71291a5f`, `938f0547`: the KOBE-439 re-review LOWs (see KOBE-439.md).
- `1203f203` protocol (**its own commit, for its own PR**): `app-cards.ts`
  (`APP_CARD_CUSTOM_TYPE` `kobe.app_card`, `CAPABILITY_APP_CARDS`, `ka-` ids, `appCardContent`,
  `appCardEntrySchema`, launch body and response) and `run.start.app_cards` (≤ 20).
- `4653b1c9` db **0153** (generated, alone): `thread_app_results.opened_by` (users, set null),
  `card_text`, `queued_at`, CHECK `thread_app_results_queued`; upgrade test
  `thread-app-cards-upgrade.db.test.ts`. **Next free: 0158.**
- `e5caa61e` server, `3c252de0` server (`needsKey`), `7e035178` sandbox-agent, `65a077e5` web,
  `08f95e28` Markdown export, then docs.

## Design

- **Launch** (`services/server/src/apps/app-cards.ts`, routes `routes/thread-app-cards.ts`):
  `POST /v1/threads/{id}/app-cards {app_id}` and `POST /v1/threads/app-cards` (new thread, the
  team's default agent, titled after the app). Order: MA8 `memberApp` → the thread is the
  member's own, live, not a test or eval thread → ≤ 5 waiting → the MA-4 rate token →
  `callApp(opening tool, {})` (policy, audit `mcp.app_call`, the member's credential) →
  `isError` refuses (502 `app_open_failed`, nothing stored) → `persistAppResult` (MA10 inline,
  blob or `too_large`, quota; refactored out of the capture store and shared) → under the thread
  lock: no active run → `custom_message` entry at the leaf, leaf moves; active run → the row
  waits (`queued_at`, `card_text`). No run row, no `run_events`, no model call, no wire frame.
- **Content** (T14): `APP_CARD_PREAMBLE`, then `<app-card source="connector:…" tool="…"
opened_by_member="true" untrusted="true">` with the text blocks (≤ 8 KiB UTF-8, `<>&` as
  entities, invisible characters escaped) and `</app-card>`. `details` holds connector, app,
  tool, template hash, `result_ref`, `opened_by`: Pi never gives it to the model.
- **Queue** (D17): `promoteInTx` inserts waiting cards in launch order at step 0, after the
  active-run check and before choosing the next queued run (same thread lock). `DELETE
…/app-cards/{ref}` removes a waiting card (its blob queued for deletion).
- **Pi catch-up**: `appCardChain` (the unbroken chain of cards ending at the run's branch point)
  goes in the start plan (also on a recovery restart); the agent (`appendAppCards`,
  `missingAppCards`) appends the missing ones with Pi stopped, creating a new thread's session
  from its first card, then the branch marker. Without the capability, delivery drops them and
  starts below them (`withoutAppCards`).
- **Mirroring**: `ka-` ids are server-only (`isServerEntryId`); a known id now counts as
  `existing` before the reserved check (Pi echoes the cards back); cards are never the
  `get_entries` cursor; restores include them (Pi resumes at a card that is the leaf).
- **Views**: `GET …/app-results` gains `queued`; `GET /v1/team/apps` gains `needsKey` (apps
  missing only the member's own key; a missing site key gives no hint).
- **Web**: `parseEntry` → `appCard` (only `ka-` ids with the server's `customType`); `tree.ts`
  makes it its own assistant node (`meta.appCard`, no answer actions) with a
  `data-kobe-app-card` part → `components/apps/app-card.tsx` ("You opened _app_ from _connector_",
  then `LiveApp` from the tool card: lazy, 3 live, Expand) or the text reason. Rail
  `components/shell/rail-apps.tsx` between Threads and Files (hidden with no apps; collapsed
  icon `show-apps`; "Add your key" as an `InlineLink` to `/me/connectors`); a launch goes to the
  thread on screen, or a new thread from the new-thread view, a read-only or Trash thread.
  Waiting cards: `components/apps/queued-app-cards.tsx` chips in the steering panel (× removes,
  Expand opens the stored result in the artifact column). `session.appCards` tells the thread
  to re-read its entries and results.

## Deviations (for review; spec amended)

1. The opening tool runs **at the click**, not at insertion: no upstream call under the thread
   lock, and Expand while waiting has data. A waiting card's data is from the click.
2. A launch from a read-only (shared) thread or one in Trash starts a new thread.
3. Removing an inserted card (`context_edit`, spec "Removing") is not built: Kobe has no
   `context_edit` support yet and no ac asks for it. Follow-up ticket suggested.
4. A compaction started while a card is Pi's missing leaf compacts Pi's own leaf; the card then
   sits on a side branch. Narrow (compact right after a launch, before any message).

## Acceptance criteria

- **ac-1** MA8 + hint: server `team-apps.db.test.ts` "hints 'Add your key' only for…"; web
  `app-cards.test.tsx` "is absent without apps, and says 'Add your key'…".
- **ac-2** no run, no model call, no spend; new thread: `app-cards.db.test.ts` (entry at the
  leaf, one `callApp` with `{}`, audited, no new run, no `run.start`; new thread titled after the
  app with the card first); web "launches an app into the current thread…", "starts a new
  thread…", "renders a launched card…".
- **ac-3** fenced, untrusted, opened by the member; no structured result or template:
  `app-cards.db.test.ts` "gives the next run the card…" (and an old agent starts below it);
  protocol `app-cards.test.ts`; agent `agent.runs.test.ts`; **real Pi 1.0.0**
  `app-cards.real-pi.test.ts` (the scripted model echoes `[card content, prompt]`). Run here with
  `KOBE_TEST_PI_BIN` pointing at another worktree's Pi install: passed.
- **ac-4** queued and inserted before the next queued message; removal cancels; never wakes a
  sandbox: `app-cards.db.test.ts` "queues…", "removing…", ac-2's frame count; web "queues a
  launch during a run…".
- **ac-5** team switch: the team switcher reloads the page (`app/team-switcher.tsx`), so no
  frame survives; frames are keyed by team too (`frameKey`, KOBE-437 MEDIUM-1 test).
- Fork copies cards and their results (`app-cards.db.test.ts` "follows its thread"); the
  Markdown export carries the card's text only (`export-markdown.test.ts`).

## Tests run (all green)

protocol 931; db unit 598, probe 657, upgrade (0153-0153) 11; server unit 2,116; server DB
`app-cards` 8, `app-context`, `app-results`, `team-apps`, `sandbox-wire(-entries)`, `runs`,
`runs-queue-*`, `run-prompt`, `thread-fork`, `thread-compact`, `runs-interrupted`, `retention`,
`retention-forks`: 205+; sandbox-agent 859 (+1 real Pi); web 2,055; typecheck, lint, format,
`license:check` (no new dependency).

## Notes for MA-8

- The k3d gate's fake MCP needs an opening tool with no required arguments for the rail launch.
- Gate step "From the rail" checks: the card, no run, then the next run's prompt has the fenced
  card (Pi session file or the model gateway's request log).

## Review fixes (review-ma6: MEDIUM-1, MEDIUM-2, LOW-1..6), coordinator rule "no card may leave a thread unable to run"

- MEDIUM-1: `appCardContent` escapes first, then cuts to 8 KiB (never inside an entity or
  `\uXXXX`) with `[truncated]`; every entry is validated (`appCardEntrySchema`) before it is
  written (422 `app_card_invalid`). Tests: protocol (8 KiB of `<`, `&`, U+200B, bidi); DB "fits
  any result…" (inserted and queued, then runs).
- MEDIUM-2: a card's parent is `piBranchPoint(leaf)`, never a `ku-` prompt. DB "never hangs a card
  under an unsent prompt" (failed start, launch, the next run starts with the card).
- LOW-1: ≤ 20 cards in a row: launch refused 409 `too_many_cards`; a waiting card that would pass
  it is dropped. DB "caps cards in a row at 20…" (the 20 still run) and "drops a waiting card…".
- LOW-2: insertion re-checks access (SQL in the thread transaction) and age (10 min); a drop
  deletes the row, queues its blob, audits `mcp.app_card_dropped` (new action, docs/audit-log.md)
  and the chat says so (`DroppedAppNotice`). Waiting cards go in whenever no run is active,
  also during the abort hold and before a later launch. DB tests "drops a card whose app…",
  "inserts a card left waiting…"; web "says when the server dropped a waiting card".
- LOW-3: own limiter `APP_LAUNCH_RATE` (5, then 0.5/s per member), taken first. DB test.
- LOW-4: a new thread is created in the card's transaction. DB test (error result, no thread).
- LOW-5: titles via `fallbackTitle` (unsafe characters removed). Unit `apps/app-cards.test.ts`.
- LOW-6: cross-team launch and DELETE (404), another member's DELETE (404), builder test thread
  (`is_test`) refused. A launch from a project's new-thread view starts outside the project with
  the default agent (spec MA11 "the team's default agent").

## Re-review LOWs (R1, R2)

- R1: the insert-time re-check also needs the opening tool pinned (not drifted), naming the
  template, and in the team's exposure (`exposedToApps`). DB test "drops a waiting card whose
  opening tool left the exposure or drifted".
- R2: while Pi still aborts a stopped run (Stop's grace), waiting cards wait and a launch queues;
  the sweep's stalled-thread pass also finds threads with waiting cards and no run, so the
  promotion inserts them once the hold is over, on the branch the next run continues. DB test
  "keeps a card launched during Stop's grace waiting…".
