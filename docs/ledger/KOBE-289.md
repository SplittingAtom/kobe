# KOBE-289: More remember choices on approvals, My approvals page, admin limits

- **Status:** in progress (group 2, branch `group-2-quality`, not pushed)
- **Branch / worktree:** `group-2-quality` in `../Kobe-g2`
- **Depends on:** KOBE-37 (approvals), KOBE-35 (policy engine), KOBE-294 (console primitives)

## What changed

- **Protocol** (`packages/protocol/src/remember.ts`): `REMEMBER_SCOPES` (`thread`, `today`, `run`,
  `day`, `month`, `forever`) with card labels; `rememberRuleSchema` is now
  `{tool_glob, scope, exact?}` (the client no longer sends `expires_in` or `arg_pattern`);
  `rememberLimitsSchema` + `tightenRememberLimits` / `looserThanFloor` / `scopeWithinLimits`;
  `approveAllBodySchema`; run event `policy.rule_applied` `{tool_call_id, tool, rule_id, scope}`.
- **Migrations:** `0124_tool_rules_exact_keys.sql` (generated, review S3), `0122_tool_rules_remember.sql` (generated: `tool_rules.remember_scope`,
  `thread_id`, `run_id`, `last_used_at`, FKs `(team_id, thread_id) → threads` and
  `(team_id, run_id) → runs` ON DELETE CASCADE, partial indexes; `users.time_zone` with a length
  check) and `0123_tool_rules_remember_scopes.sql` (custom: backfills KOBE-37 rules by expiry,
  then CHECKs `tool_rules_remember_scope` and `tool_rules_remember_binding`).
- **Engine:** `rules.ts` binds user rules to the call (`bindingMatches`: a `thread` rule only in
  its thread, a `run` rule only in its run, a bound rule that names none never matches);
  `remember-limits.ts` applies the team's effective limits at evaluation (scope allowed, age under
  max duration, MCP allowed, exact-only, never a destructive tool). `evaluate.ts`: unattended runs
  (auto, scheduled) allow-list with team allow rules only. Reason text "Allowed by your rule
  (<scope>)."
- **Rule source:** `live-rule.ts` reads a bound rule only while its thread exists, is not deleted
  or archived, is still the owner's and in a project they can open (member, mode `team`, or team
  admin), and while its run is active; plus the limits (`remember-limits-store.ts`) in the same
  team transaction.
- **Remember** (`remember.ts`, `remember-scope.ts`): scope checked against limits and risk
  (destructive refused server-side now), exact pattern derived from the stored canonical input
  (`exactArgPattern`: built-in primary argument, else every top-level argument; literal globs),
  expiry from the clock, the stored time zone (`endOfLocalDay`, DST-aware) and the max duration;
  `thread`/`run` rules name the approval's own thread/run. Ended rules are pruned (audited,
  system actor) before the cap is counted.
- **Approvals:** `GET /v1/approvals/{id}/remember` (options the card may offer),
  `POST /v1/approvals/approve-all` (`approve-all.ts`: one transaction, each approval signed, marked,
  announced and audited on its own, `approveAll: true`; refused as a whole if any is destructive or
  open-world, not pending, another run's, or the limits forbid it). `decide.ts` now shares
  `allowRowInTx` with it. The approval service takes the server's tool registry.
- **Visibility:** `rule-applied.ts` records, before the call runs, `last_used_at`, audit
  `policy.rule.applied` (actor: the member) and event `policy.rule_applied`; a rule gone in between
  denies the call. The MCP proxy records it too (`enforcementPoint: mcp_proxy`, no event) and
  `mcp.tool_call` carries `ruleId`.
- **Routes:** `/v1/team/policy/member-rules` (GET, DELETE; team admins), `/v1/team/policy/
remember-limits` (GET members, PUT team admins; `limits_above_floor`), `/v1/site/policy/
remember-limits` (site admins), `/v1/me/time-zone` (GET/PUT). `my-rules` answers the new
  `MemberRuleView` (scope, thread title, last used). OpenAPI regenerated.
- **Web:** approval card (`approval-remember.tsx`) offers only the server's choices with their
  server expiry, "Only this exact action" with the pattern shown before saving (forced under
  exact-only), "Approve all waiting (N)" with an inline confirm; tool card "Allowed by your rule
  (<scope>)"; My area **Approvals** page (`/me/approvals`, list, revoke, time zone; linked from the
  profile menu); team Policy page: members' rules with revoke and the team limits form (floor
  choices disabled, save clamped); Site policy floor: limits form.

## Decisions

- **D29 extension** (as the ticket says): a user rule is user × tool glob × optional argument
  pattern **× optional thread or run** with a server-computed expiry. Recorded here.
- **Remembered rules never apply to unattended runs.** Before, a member's remember-rule also
  allow-listed the tool for their auto and scheduled runs (`evaluate.ts` `allowListed`, tests "user
  allow allow-lists … in auto/schedule"). The ticket's non-negotiable says they never do, so those
  tests now expect a deny; only team allow rules allow-list there.
- **Destructive tools are never remembered, server-side too.** Before only the card hid it; the
  server stored such a rule. Now `remember_not_allowed`, and the engine ignores a stored one. So
  "exact command" for `bash` is never offered (`bash` is destructive); exact applies to file
  paths, Kobe tools and MCP arguments.
- **Limits apply at evaluation**, not only at creation: tightening the team or floor turns off
  rules it no longer allows at once (max duration counted from `created_at`).
- **Floor vs team:** effective = field-wise tightening of both; a team PUT looser than the floor
  is refused. An unreadable stored value reads as "nothing may be remembered" (fail closed), none
  as the defaults (everything, as before).
- **Time zone:** a new `users.time_zone` (null = UTC), set on My area, Approvals; the card shows
  the server's midnight before saving. Never taken from a decision request.
- **No "My approvals" bar icon:** the command palette's area links stay as they were (adding one
  re-flowed the utility bar); the page is linked from the profile menu and named on tool cards.
- **"Approve all waiting"** shows on the card whose options were read once two or more wait (an
  earlier card does not refresh its options).
- Audit: `policy.rule.applied`, `policy.remember_limits.updated`; `toolRule` targets gained
  `rememberScope?`, `threadId?`, `runId?`; `approval.decided` `approveAll?`; `mcp.tool_call`
  `ruleId?` (docs/audit-log.md).

## Release notes (behaviour changes members and admins will notice)

- **Scheduled and auto runs no longer use remembered approvals** (Chris's ticket requirement,
  D32). Before, a member's remembered rule also allow-listed that tool for their schedules and
  auto-mode threads. **Existing schedules that relied on a remembered rule now skip those calls**
  (each shows as a skipped action on the run). To let a tool run unattended, a team admin adds a
  team allow rule.
- **Destructive tools are never remembered** (Chris's ticket requirement). The server now refuses
  it (only the card hid it before) and the engine ignores stored rules for them: older rules for
  `bash` and for MCP tools without annotations (which count as destructive) stop applying. My
  approvals and the team Policy page list them as "No longer applies" with the reason.
- **API:** `POST /v1/approvals/{id}` `remember` is `{tool_glob, scope, exact?}`; the spec §6.1
  shape `{tool_glob, arg_pattern?, expires_in?}` is refused (review N5). `my-rules` answers the
  new rule view (scope, last used, applies).
- Backfill labels (review N6): a KOBE-37 rule longer than 30 days is labelled "for 30 days" but
  keeps its stored expiry.

## Security review fixes (Opus review, 2026-10-17)

- **S1** MCP proxy: when a remembered rule decided the named run, every other active run of the
  sandbox is decided on its own (no context dedupe), so thread A's rule never allows a call while
  thread B runs (`mcp/decide.ts`; test in `mcp.db.test.ts`).
- **S2** Thread rules end for good: archive, Trash, project move and clearing test threads delete
  them (audited, system actor); losing project access (member removed, selected mode, no longer
  team admin) ends them too (`endThreadRules`, `endUnreachableThreadRules`). Tests: unarchive,
  restore, move back.
- **S3** Exact MCP/Kobe rules pin every top-level argument and the key set (`tool_rules.
exact_keys`, migration `0124_tool_rules_exact_keys.sql`): an extra or missing argument doesn't
  match. File tools pin only the path; the card says "Only this path" and that the content may
  differ.
- **S4** Exact-only counts only all-literal patterns; an older wildcard rule is ignored.
- **S5** Rules the engine ignores show as "No longer applies" with the reason and offer only Remove.
- **S6** (D18) The team Policy page masks a private thread ("a conversation") and argument values
  (only their names); shown when the thread is shared.
- **S7** Tests added for all of the above, approve-all with another run's id, a call arriving
  after the options were read, and a new run (as Regenerate) asking again.
- Nits: N1 the rule-applied record re-checks liveness; N3 approve-all expires an approval whose
  connection is gone, as a single decision does; N4 approve-all never includes project writes;
  N5/N6 above. N2 (zone choice makes "today" up to about 24 h; zone changes not audited) and N7
  (number vs string subjects) are left as they are.

## Re-review fixes (2026-10-17)

- **R1** A "this conversation" rule can't be made for a thread that is archived, in Trash or out
  of the member's reach: the card doesn't offer it and the server refuses it
  (`remember_not_allowed`, `threadLiveFor`), so unarchiving never brings one back.
- **R2** Under exact-only, a rule for a tool without a primary argument (MCP, Kobe tools) counts
  as exact only with its key set pinned (`exact_keys`); an older literal rule is ignored.

## Open questions (for Chris or the coordinator)

- None blocking. The e2e browser spec runs on gate1 later (needs a team admin `KOBE_USER`).

## Evidence (acceptance criteria → test or command output)

- **ac-1** scopes, server-enforced: `policy/remember-scopes.test.ts` (thread/run binding, labels,
  expiries incl. DST), `remember-scopes.db.test.ts` (thread: other thread asks, archive, delete,
  project out of reach; run: next run asks; today: stored zone), `packages/db`
  `tool-rules-remember.db.test.ts` (checks, cascades, backfill), probe suite green.
- **ac-2** exact action: unit (escaping, canonical path, MCP arguments, unavailable cases) and db
  (pattern shown by `/remember`, `q3*.md` literal, client pattern refused, `glob_too_broad`).
- **ac-3** approve all: db (both signed with distinct MACs, two `approval.decided` with
  `approveAll`, run resumes; refused with a destructive one, by limits, 404 for a reader of the
  shared thread); web test (button, confirm, body).
- **ac-4** pages: `my-approvals.test.tsx`, `policy-pages.test.tsx` (members' rules, revoke with
  team header); db: member revoke and admin revoke take effect at once, other team's admin 404.
- **ac-5** limits: db (team limits, floor binds and refuses looser, tightening applies at once,
  members can't PUT); web (card choices follow the server, exact-only forced, form disables
  floor-forbidden choices and clamps the save).
- **ac-6** visibility and unattended runs: db (event + audit naming the rule, `last_used_at`;
  scheduled and auto runs denied, no approval row; MCP proxy allows with `ruleId`, revoke denies,
  scheduled ignores it); web (tool card note).
- Commands (2026-10-17): format:check, lint, typecheck green; `pnpm test` 27/27 tasks (one earlier
  run under load had a timing flake in `@kobe/server` and `@kobe/sandbox-agent`, both green alone
  and on the rerun); `@kobe/db test:db` 51 files / 1238 tests; `@kobe/server test:db` 118 files /
  1614 tests; `license:check` green (no new dependencies); public hygiene and site wording ok.
