# KOBE-258: Run that hits the model output limit is lost

- **Status:** in review (PR #243)
- **Branch / worktree:** `kobe-258-lost-run-output-limit` in `../Kobe-wt258`
- **Depends on:** none (related: KOBE-259, per-model output limit)

## Root cause

Not the output limit, and not the tool executor: a thread's **first run** loses its entries
whenever the thread's Pi restarts between the server's first `get_entries` and the prompt.

1. Before a thread's first `run.start` on a connection the server syncs (`#ensureSession`,
   `get_entries` without `since`). The sandbox agent spawned a bare Pi for that command (no run
   config).
2. Pi 1.0.0 (`SessionManager._persist`) keeps a **new** session's setup entries (`model_change`,
   `thinking_level_change`) in memory only; the file is written at the first user message. Pi
   answered `get_entries` with those in-memory entries, and the server mirrored them (cursor `X`).
3. `run.start` carries the agent's config, so the launch key differs and the agent restarts Pi.
   The new Pi finds no file, starts a new session with **new** entry ids, and writes it.
4. Every later `get_entries since X` fails (`Entry not found: X`, `pi_rejected`): nothing of the
   run is mirrored, yet `agent_settled` ended the run `completed` (leaf = `X`).
5. The next run: `since X` is rejected again, so the server "restores" Pi from Postgres, which
   holds only `X`: Pi's real session file (user message, reply) is overwritten. Context gone.

Reproduced with the real pinned Pi in `session-continuity.real-pi.test.ts` (fails on main with
`Entry not found`). Gate evidence (read-only query, 2026-10-11): five recent threads hold only one
`thinking_level_change` entry after a run, and several more show the restore pattern
(`thinking_level_change, custom, model_change, thinking_level_change, …`). The 16384-token stop in
the incident only made the loss visible (a long, expensive answer vanished). Why some older first
runs survived: most likely no restart (the run's launch key matched the bare Pi's).

Pi itself is not changed (third party, pinned): the agent works around its lazy persistence.

## Decisions

- **sandbox-agent (the fix):** a `get_entries` without `since` while the thread's session file does
  not exist is answered `{entries: [], leafId: null}` without starting Pi: nothing is durable yet.
  Once the file exists Pi writes every entry immediately, so its answers are durable.
  (`threads/manager.ts`.)
- **sandbox-agent logs every refused command** at info with Pi's text (`command refused`: type,
  thread, run, Pi command, code, error capped at 500 chars). Unexpected Pi exits were already logged
  at warn; the restart in step 3 was expected and is no longer harmful.
- **server, defence in depth (older agents, any other lost cursor):** when Pi rejects `since` and
  Postgres holds no user/assistant message for the thread, Pi's whole session is adopted
  (`get_entries` without `since`) instead of restoring a near-empty session over it
  (`delivery.ts #entriesSince`, used by `fetchNewEntries` and `#ensureSession`). With a
  conversation in Postgres the restore stays as before. Stale setup entries stay as an unused root.
- **server: a run whose entries could not be mirrored at run end ends `failed`**,
  `entries_not_saved`, with the server's own message (a model failure, if any, stays the reason).
  Pi's error text is logged with "entry sync failed" and "Pi session lost" (capped, untrusted).
- **Output limit:** a run whose last assistant message has `stopReason: "length"` ends `failed`
  with `model_output_limit` ("The model hit its output limit before it finished…"). No contract
  change: `run.failed.error.code` is a free string and the server owns the codes and messages
  (`runs/failure-codes.ts`); the web already shows `The run failed: <message>`. The cut-off
  message itself is kept (mirrored) and the thread view marks it ("The model hit its output limit
  here, so this reply is incomplete.", notice style) so the marker survives a reload.
- `maxTokens` 16384 untouched (KOBE-259).

## Open questions (for Chris or the coordinator)

- Threads already damaged on kobe-gate1 cannot be repaired: their Pi session was overwritten by
  the restore. Nothing to migrate.
- Follow-ups named in the ticket (not here): a larger output allowance for reasoning models
  (KOBE-259) and prompting Kobe to write files with tools instead of in its reasoning.
- `agent.models.test.ts` "sibling planted … during its start (tripwire)" failed once in a full
  local run under load and passed 11 times alone or by file (a 1 ms polling race, pre-existing).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/sandbox-agent/src/session-continuity.real-pi.test.ts` (real Pi 1.0.0, faux
  model streaming only reasoning with `stopReason: "length"`): a bare `get_entries` reports
  nothing, the run's Pi (another launch config) writes user + cut-off assistant, `get_entries`
  returns them, and the next run (another restart) sees the first prompt in its context.
  Server side: `sandbox-wire-entries.db.test.ts` "keeps a turn cut off at the output limit" (both
  entries mirrored).
- **ac-2** `translate.test.ts` "the model's output limit (KOBE-258)"; db test above: run `failed`,
  `run.failed` `model_output_limit` with the server message; web `tree.test.ts` "marks a reply cut
  off at the model's output limit".
- **ac-3** `sandbox-wire-entries.db.test.ts` "never completes a run whose entries could not be
  saved" (`failed`, `entries_not_saved`); `agent.entries.test.ts` "logs Pi's refusal text"; server
  logs carry `error` on "entry sync failed" / "Pi session lost".
- **ac-4** root cause above; `agent.entries.test.ts` (no entries and no Pi before the file
  exists); `session-continuity.real-pi.test.ts`; `sandbox-wire-entries.db.test.ts` "adopts Pi's
  session when it lost the cursor and Postgres has no conversation yet" (the incident replayed:
  entries mirrored, run completed, next run without restore).
- `pnpm verify` green; `pnpm --filter @kobe/server test:db` 1233 tests, the one failure (a restore test whose fixture had role-less messages) fixed and rerun green.
