# KOBE-493: The agent cannot write or edit the file the member is viewing directly

- **Status:** in review (committed locally, not pushed)
- **Branch / worktree:** `kobe-493-viewed-file-guard` in `../Kobe-wt493`
- **Depends on:** KOBE-462 (viewed file), KOBE-467 (regenerate `viewing_from_entry`)

## The rule (for docs/file-editing.md once PR #381 lands; coordinator updates it)

Replace the gap-3 note with:

> **The viewed file is guarded (KOBE-493).** When a run carries a viewed file (`runs.viewing.path`:
> set at send, again on Retry, and on regenerate from `viewing_from_entry`; kept as path only when
> the file could not be read), the server's tool decision for Pi `write` and `edit` whose target
> is that file is, in every mode (Dangerous and remembered approvals included; a member-protection
> rule like `tools.deny`), with reason code `viewed_file`:
>
> - the agent can propose (sandbox announced `file_edits` and its tool lists leave
>   `propose_file_edit`): **deny** with the tool error "The user is viewing <path>. Propose the
>   change with propose_file_edit instead; nothing was written." (stage `site_deny`; recorded as
>   the call's `policy.denied`; the tool card says "Not written: you're viewing this file");
> - otherwise: **ask** the member (stage `ask_rule`, first in the card), never allowed without
>   asking; the card offers no "remember" (it would be ignored) and the call is left out of
>   "Approve all waiting"; `auto`/scheduled/skill-eval runs, where nobody can be asked, deny.
>
> An engine deny stands. Paths are compared as normalised strings: Pi's path resolved against
> `/workspace` (absolute or relative, `./`, `../`, `//`, trailing slash), then workspace-relative;
> case-sensitive. **Not covered:** `bash`, `powershell`, `run_python` (which can also write a
> viewed `.ipynb` or `.py`), any other tool that writes files, and other names for the same file
> (symlinks and hard links are not followed). `propose_file_edit`, `open_file` and other paths are
> unaffected.

## Decisions

- **No migration.** `runs.viewing` (KOBE-462) already keeps the path for the run's whole life
  (ended runs keep path + sha), and regenerate/Retry write the new run's own `viewing`. The run
  context source reads `viewing ->> 'path'` in the same query as `approval_mode`.
- **Where:** pure `services/server/src/policy/viewed-file-guard.ts` (`guardViewedFile`), applied in
  `sandbox-wire/policy-check.ts` right after the engine, before the allow/deny/ask branches, so
  the existing branches do the rest: deny → `policy.denied` + skipped-action record; ask →
  never-prompt/eval deny or the HMAC-signed approval broker (unchanged). A Dangerous or remembered
  allow becomes deny/ask, so no Dangerous audit row is written for it.
- **Capability:** `file_edits` from the connection's `hello.capabilities`, passed to
  `decidePolicyCheck` as `target.fileEdits`.
- **Not in the engine** (`evaluate.ts`): `PolicyInput` is a protocol contract with no viewed path;
  adding one would be a protocol PR. The MCP proxy check (`policy/http.ts`) never sees Pi tools.
- **Reason code `viewed_file`** (review fix 5) added to `POLICY_REASON_CODES`. Backward
  compatible: server → sandbox reason codes are open on the wire (`wirePolicyReasonSchema`,
  `OPEN_CODE_PATTERN`; frames.ts "Forward compatibility"), so older sandboxes decode it (test in
  `sandbox-wire/frames.test.ts`). Web label in `tool-call.tsx` (`outcomeLabel`); skipped-run
  summary label in `skipped-summary.ts`. No audit code list carries policy reason codes.
- **Review fixes** (after ed838538): path-only `runs.viewing` when the read fails (orchestrator
  `#viewingOf`; agent-internal paths stay null; run.start gets no viewing, since the protocol's
  `RunViewingContext` needs a version: telling the model "content unavailable" would be a protocol
  change); ask instead of a refusal when `propose_file_edit` is unavailable (`proposeAvailable`:
  no `file_edits`, or the agent's `tools.deny`/`tools.allow` removes it); no remember for
  viewed-file asks (`remember-options.ts` reason, `decide.ts` 403, `approve-all.ts` not batchable).
- Docs: rule described in `docs/approvals.md` (when a call asks). `docs/file-editing.md` untouched.

## Open questions (for Chris or the coordinator)

- Should a path-only viewing (file unreadable) still tell the model it is viewing the file? Needs
  `RunViewingContext` without `sha256` (protocol PR).

## Evidence (acceptance criteria → test or command output)

- ac-1: `viewed-file-guard.db.test.ts` "with file_edits, write and edit … refused" (deny, message,
  one `policy.denied` each) and "in Dangerous mode too"; unit `viewed-file-guard.test.ts`.
- ac-2: db "without file_edits the member is asked, in ask-on-write and in Dangerous mode"
  (`policy.pending`, approval reason `viewed_file`), "nobody to ask (auto) means a deny" (even
  with a team allow rule for `write`).
- ac-3: unit path table (absolute, relative, `./`, `../`, `//`, trailing slash, case, outside
  `/workspace`, `~`); db: other file, different case, `propose_file_edit`, `open_file` allowed; run
  without viewing allowed. Regenerate: the decision reads `runs.viewing`, which
  `file-viewing.db.test.ts` "regenerate reuses the original run's path" shows is set.
- ac-4: unit + db tests above; browser spec `e2e/browser/tests/viewed-file-guard.spec.ts` (not
  run against gate1 here; accepts a proposal card or the viewed-file refusal, file unchanged until
  Commit all).
- Review fixes: db "asks instead of pointing at propose_file_edit when tools.deny removes it", "its
  approval offers no remember, refuses one, and is not approved in bulk"; `file-viewing.db.test.ts`
  "keeps only the path when the file can't be read" and unknown paths keep `{path}`; unit
  `proposeAvailable`; web `tool-call-label.test.ts`; protocol wire open-code test.
- `pnpm --filter @kobe/server test:db`: 189 files / 2272 tests passed. `pnpm verify`: see commit.
