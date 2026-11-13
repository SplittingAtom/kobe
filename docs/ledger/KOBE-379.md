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
  - `secrets.ts`: `matchSecret` / `matchSplitSecret` from `@kobe/skill-scanner` (exported with
    `SECRET_RULES`, `maskSecrets`, `INVISIBLE`, `IGNORABLE`). Statement, justification, note and
    tags. `memory_secret` (422) at every scope, Policy included, no override. Review fixes changed
    the shared rules, so `RULE_SET_VERSION` is `2026.11.13.6` (`RULE_SET` 6: stored skill scans
    are rescanned).
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
    takes a tx; new `loadTeamEgressIn`); Site and portable items are judged by the ceiling
    (review L-5: the reviewer's first option; the portable message says each workspace may allow
    less). `link_lookalike` for non-ASCII/punycode hosts (shown as `xn--…`). IP
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
- **Restore** runs the full checks (review H-1); the restore body is now
  `restoreSemanticMemoryItemSchema` (`expected_version?`, `overrides?`; contract change in
  `@kobe/protocol`, OpenAPI `RestoreSemanticMemoryItem`). Restore and a Policy change add no
  version, so their overrides are audited at the current version only (versions are immutable).
- **Shared quote normaliser:** `services/server/src/memory/quote-normalise.ts`
  (`normaliseQuote`, `quoteFoundIn`) for KOBE-393.
- **Docs:** `docs/guide/memory.md` "What Kobe checks before a memory is saved".

## Security review fixes (review-379, 2026-11-13)

Every verified bypass is a golden test (`checks.test.ts` "security review bypasses",
`memory-checks.db.test.ts` "restore runs every check" and "other write paths",
`memory/items/write-paths.test.ts`, skill-scanner `scanner.test.ts`).

- **H-1** restore runs `saveChecks` (lint, personal data, links, near-duplicate, Policy conflict,
  overrides audited). Write paths are listed in `items/write-paths.test.ts`: create, patch
  (statement or Policy change; tags-only edits scan the tags for secrets), Undo, restore run the
  checks; archive and pin are exempt (no text enters use). A source sweep fails on any other file
  writing the item/version tables.
- **H-2** shared `SECRET_RULES` gained `connection-string` (URL user info password),
  `password-unquoted` (`password=…`, `DB_PASSWORD=…`, `pwd: …`, "password is …"), `stripe-key`
  (`sk_/rk_ live|test`, `whsec_`), `gitlab-token` (`glpat-` and siblings), `jwt`,
  `azure-account-key`, and `xapp-` in `slack-token`. Generic values must look random
  (`plausibleSecret`: letter + digit, no placeholder, not a dotted identifier like
  `config.api_key_v2`). Skill fixtures: the only new hit is the deliberate fake Stripe key in
  `builtin-skills/code-review/scripts/sample.py` (the review demo's planted finding); it moves
  code-review 1.0.0 from Pass to Caution. No other builtin skill or fixture fires. Each builtin
  skill's verdict and finding rules are pinned in `services/server/src/skills/builtin-scans.test.ts`.
- **M-1..M-3** scanner `INVISIBLE` uses `\p{Extended_Pictographic}` (digits no longer excuse a
  selector or ZWJ; keycaps and skin-tone ZWJ sequences still pass) and adds U+180B–180F,
  U+FFF9–FFFB, U+1D173–1D17A. The quote normaliser maps blank fillers (U+115F, U+1160, U+3164,
  U+FFA0, U+2800) to a space and keeps emoji. The rule views (`plainText`) also drop every
  default-ignorable code point (new `IGNORABLE`) and, after NFKD, every combining mark.
- **M-4** a collapsed view (up to three spaces/hyphens/dots between token characters removed) is
  read only by prefix-anchored rules (`SecretRule.split`, `matchSplitSecret`), and the token must
  have a digit and no 9-letter lower-case run, so joined prose ("ghp_ prefix marks…") never
  blocks.
- **M-5** base64/base64url (24+) and hex (32+) runs, at most 8 per text and 4 KiB each, are
  decoded once and rescanned when they read as text.
- **L-1** a Policy change runs the checks on the unchanged statement. **L-2** justification and
  note get lint and (Workspace/Site) personal data. **L-3** tags are secret-scanned on create,
  patch and restore. **L-4** links: `scheme:` with 0–2 slashes or backslashes, and bare names under
  an ICANN suffix (`isRegistrableHost`, `@kobe/db`, tldts), except names ending in a file
  extension that is also a ccTLD (`.md`, `.py`, `.sh`, `.zip`, …); the lint's fetch rule uses the
  same extractor (the hard-coded TLD list is gone). Re-review follow-up: a bare name is listed
  but never `link_blocked` (only scheme, `www.` or path links are), and counts for the fetch lint
  only with look-alike letters, so `ASP.NET` or `socket.io` in prose don't warn; a look-alike
  bare name still gets `link_lookalike`. **L-5** portable links judged by the Site ceiling. **L-6**
  `memory.policy.override` audits `conflicts: [{id, version}]` (≤25; audit schema changed).
- ReDoS: every view and rule stays under 100 ms on 500-character adversarial inputs (tests).

## Open questions (for Chris or the coordinator)

- Personal-scope lint is enforced like Workspace/Site (409 until "Save anyway", audited). If
  Chris wants it advisory only (save without a round trip), the item response needs a
  `warnings` field (contract change).
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
