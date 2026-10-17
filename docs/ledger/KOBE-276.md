# KOBE-276: Turn shared thumbs-down answers into Orbit eval cases (member consent)

- **Status:** implemented on `group-2-quality` (not pushed); owner review page waits for G7
- **Branch / worktree:** `group-2-quality` in `../Kobe-g2` (group branch with KOBE-274/275)
- **Depends on:** KOBE-275 (answer_feedback), KOBE-93 (eval gate), KOBE-92 (eval image)
- **Migrations:** `0112_agent_eval_cases` (generated), `0113_agent_eval_cases_rls` (custom)

## Plan

1. Contract `packages/protocol/src/eval-cases.ts` (+ `eval_case_id` on thread feedback answers).
2. DB: `agent_eval_cases`, `agent_eval_case_history`, `orbit_evals.case_*` (0112); RLS, break-glass,
   rating key, immutability, hold history, `orbit_evals_cases` NOT VALID (0113); probes, catalog.
3. Server: preview/share/list/withdraw, owner list/read/review, retention, offboarding, export.
4. Orbit: accepted cases frozen into the eval, `cases.json` in the Job's ConfigMap, judge.
5. Image: `--cases` suite (replay + model-graded expected behaviour), test-image.sh checks.
6. Web: "Share as an eval case…" preview dialog and Withdraw on the thumbs-down UI. 7. Docs.

## Decisions

- **Sharer identity: never shown to the agent's owner.** The spec and brief say nothing, so the
  default holds: owner routes select no `user_id`, give the UTC day (`shared_on`), not the time;
  share and withdraw are not audited (team admins read the audit log); reviews are (ids, status).
  The member's own text can still identify them; the preview says so.
- **Only the conversation's owner shares** (their own words), from their own thumbs down; a reader
  of a shared thread gets `not_shareable` (their consent can't cover the owner's prompt). Gallery
  and unknown agents: `not_shareable`. Trash and test threads: `thread_unavailable`.
- **Consent = the preview's digest.** `POST .../eval-case/preview` builds the copy (shares nothing);
  `POST .../eval-case` rebuilds it with the same options and stores it only if the SHA-256 of its
  canonical JSON equals the previewed `digest` (`preview_stale` otherwise, e.g. comment edited).
- **The copy** (`copy.ts`): prompt = `runs.input`; answer = assistant text of the entries below
  `runs.user_entry_id` up to the next prompt (located by the run, not `entry_id`, 275 N2); ticked
  tool outputs of that run; earlier exchanges (≤ 2) from its branch; ticked attachment **names,
  types, sizes** only (bytes would outlive the upload and can't reach the eval). Caps 6,000 /
  1,500 chars; offloaded bodies left out; `truncated` flags it. Control chars and lone surrogates
  cleaned. No key into threads/runs/entries: only `feedback_id` → `answer_feedback` ON DELETE SET
  NULL (feedback_id), one case per rating; clearing the rating keeps the case.
- **Reviewers = the agent's owner only:** team agent → `owner_user_id` while `access.edit`; personal
  → its owner. Team admins who don't own the agent get 403 (ac-4's "admins"); install admins only
  via break-glass. Accept needs an expected behaviour (DB check too); ≤ 20 accepted per agent
  (per-agent advisory lock).
- **Legal hold, silent (275 B1 pattern):** an AFTER DELETE trigger copies a held member's case into
  `agent_eval_case_history` in the withdrawal's own statement; the response is identical. History:
  immutable, break-glass readable, delete/TRUNCATE refused while held, purged by the retention pass
  after release (`retention.eval_cases_purged`, reason `hold_released`). Copy and identity columns
  are immutable (55000); only the review changes. Owner review edits under a hold are not kept
  (owner's text, not the member's) — say if they should be.
- **Retention:** cases outlive their thread (a copy) but go once older than the team's effective
  window (by `created_at`), at offboarding (new step in `offboarding/purge.ts`), with the team.
  Held members' cases are never selected. Export: `eval-cases.json` (copy + status, not the
  owner's expected behaviour).
- **Break-glass:** memory-shaped policy: team grant all, user grant by sharer, thread grant none
  (a case has no thread). `BREAK_GLASS_READABLE_TABLES` + catalog pin; plans count 12.
- **Gate (how cases count):** `gatePublish` freezes accepted cases (`orbit_evals.case_ids`) and
  passes `cases.json` in the Job's ConfigMap + `--cases` arg; no new credential, env or Secret.
  The image replays each case (tools return the shared outputs: by tool name, else the next one;
  `NO_CASE_OUTPUT` when none) and the eval's own model grades the reply (`GRADE: PASS|FAIL`, last
  line; none = error). The report holds ids and statuses only. `judge.ts`: ASR and the cases'
  failure rate (failed / graded) are each held to the threshold, either above blocks; a case error,
  a missing/extra/duplicate case, inconsistent counts, or cases in a result for an eval that sent
  none → `errored` (fail closed). `cases.json` > 768 KiB → 422 `eval_cases_too_large`.
  Rollback of a version that already passed is still ungated (KOBE-93), so newer cases don't
  re-run then. Gallery evals take no cases.

## Remaining console work (after G7 merges, on its primitives)

API done and tested (`services/server/src/eval-cases.db.test.ts`):

- **Agent owner's "Shared cases" page** (agent console): `GET /v1/agents/{id}/eval-cases` (403 for
  non-owners: hide the entry), list open first with prompt excerpt, reasons, `shared_on` (day),
  status, `accepted`/`max_accepted`; detail `GET .../eval-cases/{caseId}` shows `content` as plain
  text (earlier turns, tool outputs, file names, rating, `truncated` note); actions via `PATCH`:
  Accept (requires the expected-behaviour textarea, ≤ 2,000), Dismiss, Reopen, edit expected
  behaviour; errors `expected_behaviour_required`, `case_limit`. Never show or ask who shared it.
- **Builder eval status** (`components/admin/team/agent-builder/eval-status.tsx`/`eval-report.tsx`):
  show `eval.cases` (`total`, `scored`, `failed`, `failureRate`), e.g. "1 of 2 shared cases
  failed", and say a block came from the cases when ASR is under the threshold.
- **Member's "My shared cases" list** (settings): `GET /v1/eval-cases` + Withdraw, for cases whose
  rating was cleared (the chat shows Withdraw only while the rating exists).

## Open questions (for Chris or the coordinator)

- Owner-only sharing (readers can't) and owner-only review (team admins can't): confirm.
- Grader = the agent's own model (the eval token is scoped to it). A site judge model would need
  the gateway principal to allow a second model.
- The migration would normally land in its own PR first; here it is its own commit on the group.
- gate1: deploy, then share a case in the browser and run a gated publish with an accepted case.

## Evidence (acceptance criteria → test or command output)

- ac-1 (met): `services/server/src/eval-cases.db.test.ts` "sharing a thumbs down after a preview"
  (preview stores nothing, ticks only, digest required, stale, once per rating, who may share);
  `apps/web/components/chat/share-case.test.tsx` (dialog, ticks, Cancel shares nothing, Withdraw).
- ac-2 (API and gate met; review page waits for G7): `eval-cases.db.test.ts` "the agent owner's
  review" (no sharer, day only, accept needs expected, dismiss, audit, cap);
  `orbit-eval.db.test.ts` "shared eval cases in the gate" (frozen ids, ConfigMap, args, pass,
  block on failure rate, fail closed); `agents/eval/{judge,job,cases}.test.ts`;
  `images/orbit-eval/test-image.sh` (39 checks incl. cases suite) on the remote Docker host.
- ac-3 (met): `packages/db/src/agent-eval-cases.db.test.ts` (rating key SET NULL, survives thread,
  immutability, team cascade, silent hold history, release); `eval-cases.db.test.ts` (withdraw
  own only, held = unheld response, purge after release, retention window, offboarding, export).
- ac-4 (met): `agent-eval-cases.db.test.ts` break-glass (team/user grant, no thread grant,
  read-only, expiry); probe fixtures (`probe-fixtures/agents.ts`, cross-team probe green);
  catalog pins; `eval-cases.db.test.ts` "who reads cases" (member, reader, other builder, team
  admin 403; other team 404; site admin refused; personal agent hidden from team admin).
