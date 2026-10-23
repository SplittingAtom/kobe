# KOBE-493: The agent cannot write or edit the file the member is viewing directly

- **Status:** in review (committed locally, not pushed)
- **Branch / worktree:** `kobe-493-viewed-file-guard` in `../Kobe-wt493`
- **Depends on:** KOBE-462 (viewed file), KOBE-467 (regenerate `viewing_from_entry`)

## The rule (for docs/file-editing.md once PR #381 lands; coordinator updates it)

Replace the gap-3 note with:

> **The viewed file is guarded (KOBE-493).** When a run carries a viewed file (`runs.viewing.path`:
> set at send, again on Retry, and on regenerate from `viewing_from_entry`), the server's tool
> decision for Pi `write` and `edit` whose target is that file is, in every mode (Dangerous and
> remembered approvals included; a member-protection rule like `tools.deny`):
>
> - sandbox announced `file_edits`: **deny** with the tool error "The user is viewing <path>.
>   Propose the change with propose_file_edit instead; nothing was written." (reason
>   `site_deny_rule`, stage `site_deny`, no rule id; recorded as the call's `policy.denied`);
> - otherwise: **ask** the member (reason `site_ask_rule`, no rule id, first in the card), never
>   allowed without asking; `auto`/scheduled/skill-eval runs, where nobody can be asked, deny.
>   An engine deny stands. Paths are compared as normalised strings: Pi's path resolved against
>   `/workspace` (absolute or relative, `./`, `../`, `//`, trailing slash), then workspace-relative;
>   case-sensitive; symlinks are not followed. Not covered: `bash`, `run_python` and anything else
>   that can write a file. `propose_file_edit`, `open_file` and other paths are unaffected.

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
- **Reason codes reused** (`site_deny_rule` / `site_ask_rule` without `rule_id`) instead of a new
  code: adding to `POLICY_REASON_CODES` changes the protocol, and an older sandbox would fail to
  parse an unknown code. The message carries the meaning.
- Docs: rule described in `docs/approvals.md` (when a call asks). `docs/file-editing.md` untouched.

## Open questions (for Chris or the coordinator)

- Want a dedicated reason code (e.g. `viewed_file`) in a later protocol PR? Then the web could
  label it specifically.
- A remembered approval on the ask path still writes a remember rule if the member ticks it; the
  guard keeps asking for the viewed file regardless (other paths would use the rule as usual).

## Evidence (acceptance criteria → test or command output)

- ac-1: `viewed-file-guard.db.test.ts` "with file_edits, write and edit … refused" (deny, message,
  one `policy.denied` each) and "in Dangerous mode too"; unit `viewed-file-guard.test.ts`.
- ac-2: db "without file_edits the member is asked, in ask-on-write and in Dangerous mode"
  (`policy.pending`, approval reason `site_ask_rule`), "nobody to ask (auto) means a deny" (even
  with a team allow rule for `write`).
- ac-3: unit path table (absolute, relative, `./`, `../`, `//`, trailing slash, case, outside
  `/workspace`, `~`); db: other file, different case, `propose_file_edit`, `open_file` allowed; run
  without viewing allowed. Regenerate: the decision reads `runs.viewing`, which
  `file-viewing.db.test.ts` "regenerate reuses the original run's path" shows is set.
- ac-4: unit + db tests above; browser spec `e2e/browser/tests/viewed-file-guard.spec.ts` (not
  run against gate1 here; accepts a proposal card or "Denied by policy", file unchanged until
  Commit all).
- `pnpm --filter @kobe/server test:db`: 189 files / 2272 tests passed. `pnpm verify`: see commit.
