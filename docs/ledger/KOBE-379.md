# KOBE-379: SMA4: memory/checks.ts — secret scan, instruction lint, Policy conflict, warnings

- **Status:** in review (local commits; coordinator opens the PR)
- **Branch / worktree:** `kobe-379-sm-checks` in `../Kobe-wt379`, on `kobe-378-sm-item-store`
  (PR #540, not merged yet; rebase keeps only the KOBE-379 commits)
- **Depends on:** KOBE-378 (item store). v1.3 wave A5. No migration.

## Plan

Two commits: (1) contract additions (`@kobe/protocol`: warning codes, justification/note caps);
(2) the check module, its wiring into the KOBE-378 store, tests, guide page.

## Decisions

- **One entry point:** `services/server/src/memory/checks.ts` `checkMemoryWrite(env, subject,
overrides)`, run inside the save's transaction. The store calls it through
  `items/context.ts` `saveChecks` (create, edit, Undo). Later paths (import commit, candidate
  save/propose/approve, suggestions) call the same function; import preview calls
  `evaluateMemoryWrite` (never throws) and `importRowStatus`; overrides are audited with
  `overrideAuditEvents`. The near-duplicate check (KOBE-378) moved into the same evaluation.
- **Rules** (files under `memory/checks/`):
  - `secrets.ts`: `matchSecret` from `@kobe/skill-scanner` (newly exported with `SECRET_RULES`,
    `maskSecrets`, `INVISIBLE`; no rule changes, so no `RULE_SET_VERSION` bump). Statement,
    justification and note. `memory_secret` (422) at every scope, Policy included, no override.
  - `lint.ts`: `instruction_imperative` (agent-addressed orders, "from now on", "ignore …
    instructions", plus the scanner's prompt-injection/conceal/exfiltration prose rules),
    `instruction_tools`, `instruction_fetch`, `instruction_egress` (allowlist/whitelist/unblock,
    enable internet, request access, use/connect a connector or MCP server). Policy exempt.
  - `personal.ts`: `personal_email`, `personal_phone`, `personal_sensitive` (a name within 80
    characters of a sensitive word). Workspace and Site items only. Heuristic; tokens such as
    UUIDs are not phones.
  - `links.ts`: every link host (scheme, `www.`, host + path; user info and port stripped);
    `link_blocked` when `decideEgress` (the proxy's own decision, `@kobe/db`) refuses it under the
    Workspace's enablement ∩ ceiling, read in the save's transaction (`loadEgressCeiling` now
    takes a tx; new `loadTeamEgressIn`); Site items and portable items without a Workspace are
    judged by the ceiling. `link_lookalike` for non-ASCII/punycode hosts (shown as `xn--…`). IP
    literals are always `link_blocked`.
  - `policy.ts`: FTS candidates against active Policy (current versions' `statement_tsv`,
    `english`): ≥ 2 shared lexemes (all for a one-word Policy) and ≥ half of the Policy's. A
    candidate conflicts unless it restates (same negation polarity and no lexeme the Policy
    lacks). Skipped for Policy items and when the Site's Policy switch is off.
  - Length caps: statement 500 (contract), justification 1,000, note 500 (new constants) →
    `invalid_request`.
- **Bypass handling** (`checks/text.ts`): `normaliseQuote` (NFKC, invisible characters from the
  scanner's `INVISIBLE`, quote/dash folding, whitespace) + Cyrillic/Greek confusable folding +
  undefanging (`hxxp`, `[.]`, `: //`); lint also reads letter-spaced and leetspeak views, lower
  case; secrets also read a view with spaces inside split tokens removed.
- **Order and errors:** invalid → secret → `memory_lint_warning` (all warnings at once, with
  `duplicates` when near-duplicate) → `memory_policy_conflict` (`policy_conflicts`). Codes
  listed in `SEMANTIC_MEMORY_WARNING_CODES` (protocol, `errors.ts`).
- **Overrides:** `overrides.lint` saves over every warning at every scope, recorded as
  `lint_override` on the version and audited `memory.lint.override {scope,itemId,version,
warnings}` (personal scopes too, as KOBE-378 already did for near-duplicates: stricter than
  "warning only" and no contract change; the UI, KOBE-384, can show a soft warning on personal
  items and a tick on Workspace/Site). `overrides.policy_conflict` needs `curates()` (owner for
  user/portable, Team admins + stewards for team, Site curators for site), recorded as
  `policy_override`, audited `memory.policy.override {scope,itemId,version,conflicts}`. Actor
  comes from the request's audit context (tested: `actor_id`).
- **Restore** runs the secret scan only (`assertNoSecret`): the version passed the checks when
  saved and restore has no overrides in the contract.
- **Shared quote normaliser:** `services/server/src/memory/quote-normalise.ts`
  (`normaliseQuote`, `quoteFoundIn`) for KOBE-393.
- **Docs:** `docs/guide/memory.md` "What Kobe checks before a memory is saved".

## Open questions (for Chris or the coordinator)

- Personal-scope lint is enforced like Workspace/Site (409 until "Save anyway", audited). If
  Chris wants it advisory only (save without a round trip), the item response needs a
  `warnings` field (contract change).
- Restore re-runs only the secret scan; a Policy added since the item was archived is not
  re-checked on restore.
- Policy conflict is a lexical candidate match; it can flag related-but-compatible statements
  (by design "candidate", overridable). Phase B may want the learning model to confirm.

## Evidence (acceptance criteria → test or command output)

- **ac-1** golden tests per rule incl. bypasses: `services/server/src/memory/checks.test.ts`
  (80 tests: confusables, zero-width, bidi, full-width, letter spacing, leetspeak, case,
  defanged and homoglyph URLs, false-positive guards).
- **ac-2** secrets at every scope, no override: `checks.test.ts` "blocks at every scope" and
  `services/server/src/memory-checks.db.test.ts` "secret scan" (create at all four scopes +
  Policy with both overrides, edit, restore, hidden variants; nothing stored).
- **ac-3** overrides audited with actor + version: `memory-checks.db.test.ts` "instruction lint
  and overrides" (create, edit v2, Undo v4) and "Policy conflict" (create v1, edit v2).
- **ac-4** links per egress model, egress/connector lint, quote normaliser:
  `memory-checks.db.test.ts` "links and personal data", `checks.test.ts` "links and the
  Workspace egress model" + `instruction_egress` cases, `memory/quote-normalise.test.ts`.
- KOBE-378 suites still green: `memory-items*.db.test.ts` (12 + 9 + 7).
