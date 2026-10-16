# KOBE-226: Gate C: Organization and composer verification (v1.1 Phase C)

- **Status:** committed on `group-4-composer` (group G4; no PR of its own). **The k3d run is
  proven at G4's CI** (no k3d outside CI); the gate1 browser run follows the G4 deploy.
- **Branch / worktree:** `group-4-composer` in `../Kobe-g4`
- **Depends on:** KOBE-219..225 (Phase C), KOBE-164 (projects e2e), KOBE-284 (fork e2e)

## Plan

Two new sections in `e2e/run.sh` (shards `suite`, `executor`, `all`), right after the KOBE-284
fork section, in the same style (`chat_run`, `as_owner`, `psql_kobe`, one node script in the server
pod, `contains` on `key=value` lines):

1. `==> auto-titles and follow-ups (KOBE-219, KOBE-222)`: follow-ups switch on; an untitled thread;
   run 1 → epilogue `title`+`followups`, title `fake-openai: First message` (not the fallback),
   `thread.updated` + `thread.suggestions`, `title`/`followups` usage rows without a sandbox, the
   chips; rename (locked); run 2 → follow-ups only, no title event or usage, title unchanged;
   switch off; run 3 → empty epilogue, no events, no usage.
2. `==> organize and team sharing (KOBE-220, KOBE-221)` (`ORG_JS`, Owner + reader): pin/unpin,
   archive/unarchive (lists, archiving unpins, 409 `thread_archived`, reader 404), move into a new
   project, project share, reader can't move, move out ends the share (reader 404), `thread.moved`
   audited ×2; a `kobe-slow-start` run makes a second thread busy: move 409 `thread_busy`, Stop,
   then the move goes through; team share: reader reads read-only, Shared with me, 403
   `read_only` on send and share, forks, owner 404 on the fork, revoke → reader 404; audit rows;
   the Owner (checked `team_admin`) gets 404 on the reader's private thread, reads the shared one
   read-only, lists only it, 403 on send.

Then `docs/gates/gate-c.md`.

## Decisions

- **No fake-llm change.** The fake echoes the last user text, so the title call's reply is
  `fake-openai: First message:\n…`; `normaliseTitle` gives `fake-openai: First message`
  (deterministic, and distinct from the fallback, which would be the prompt). Follow-ups: lead-in
  lines ending in `:` are dropped, so the chips are `[prompt, "fake-openai: prompt"]`. Both checked
  by running the server's own `normaliseTitle` / `parseFollowups` (built `dist`) on the fake's reply.
- **Rename lock:** a rename always sets a title, so the API can't produce "locked but untitled";
  the check is the one asked for: after a rename, later runs announce no title call and the title
  stays. The rename-during-call race stays with `thread-title.db.test.ts`.
- **Busy move** uses KOBE-290's `kobe-slow-start` marker (the fake holds the answer 120 s; Stop
  ends it), so "a run is active" is deterministic; the move is retried up to 5 × 1 s after Stop in
  case the Stop's own write holds the row (`thread_busy` on lock timeout).
- The team-admin case needs no run: the reader's two threads are empty (sharing needs none).
- Shard table in the gate doc: Gate A has no CI shard (signed off on gate1 browser evidence,
  2026-10-14); `suite`/`executor` carry Gate B and Gate C; `gate1`/`gate2` the earlier gates.

## Added CI time (estimate)

About **1 min** per `suite`/`executor` shard: three runs on the Owner's warm sandbox (the KOBE-284
section's runs took 3–17 s each in run 38884955302, the long ones being 11 s sign-in rate-limit
waits), epilogue waits of a few seconds, and five more node execs (≈ 9 sign-ins, so likely one or
two 11 s waits). The `gate1`, `gate2` and `cold-start` shards are unchanged.

## Open questions

- None blocking. ac-2 and ac-3 are ticked after G4's CI and the gate1 deploy (browser specs listed
  in the gate doc).

## Evidence

- `bash -n e2e/run.sh` passes; shellcheck 0.11.0 (`uvx --from shellcheck-py`): 31 findings before
  and after, none in the new lines.
- `ORG_JS` extracted, `node --check`ed, and dry-run against a local in-memory mock of the routes it
  calls (owner/reader, the organize/share rules): every one of the 38 `organize:`/`share:` checks
  passed with the harness's `contains`.
- Title and follow-up parsing: the server's `normaliseTitle` / `parseFollowups` on the fake's
  replies give exactly the strings the checks expect.
- k3d: **pending, proven at G4's CI.**
