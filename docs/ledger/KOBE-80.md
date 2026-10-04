# KOBE-80: 49c: Skill review queue and team toggle for personal skills

- **Status:** in review
- **Branch / worktree:** `kobe-80-skill-review` in `../Kobe-wt80`
- **Depends on:** KOBE-78 (bundles), KOBE-79 (scanner), KOBE-76 (resolver inputs), KOBE-83 (editor)

## Plan

Scan on upload, store results in their own tables, review queue and team switch behind
`team.skills.review`, then feed the resolver inputs. Tests first at each step.

## Decisions

- **Migrations:** `0055_skill_reviews` (tables, enum) and `0056_skill_reviews_rls` (RLS, FORCE,
  canonical policy). Team tables `team_skill_reviews` (PK team, skill, version; FK to the immutable
  version row, cascade) and `team_skill_settings` (one row per team). Both added to
  `tenancy/agents.ts` and the probe fixtures; no install-wide tables or grants.
- **Scan at upload** (`skills/review.ts`): the canonical zip (the stored, hashed bytes) is unzipped
  and passed to `@kobe/skill-scanner` before the blob is written, so a scan failure leaves no
  orphan. The review row (`pending`, `flagged` = any finding, findings/scripts/skipped as jsonb) is
  inserted in the same transaction as the version. Unflagged versions are pending too (D22 default;
  the "open" alternative is not built). Findings carry masked excerpts only.
- **Usable = approved.** A version with no review row (uploaded before this ticket) is unusable.
  A decision can be reversed (approved -> rejected takes it out of use); re-sending the same
  decision is 409. A newer pending or rejected version never hides an older approved one: the
  resolver picks the newest approved version of each named skill.
- **API** (`routes/team-skill-review.ts`, one line in `app.ts`, `/v1/team/skill-review`):
  `GET ?status=pending|approved|rejected|all` (flagged first, then oldest), `POST
/:skillId/versions/:n {decision, note?}`, `GET/PUT /settings {personalSkillsDisabled}`. All but
  the settings read need `team.skills.review` (team admin); the settings read is `team.read`.
  `GET /v1/skills/:id/versions[/:n]` and the upload response gained `review: {status, flagged}`
  (null for personal skills).
- **Audit:** `skill.reviewed` (team view; decision, previous, flagged), `skill.personal_switch.changed`
  (team view; only on a real change), `skill.uploaded` gained optional `findings` count.
  Documented in `docs/audit-log.md`.
- **Resolver wiring** (`runs/resolver-input.ts`, `runs/agents.ts`): agent skills = the named team
  skills' newest approved versions (name + hash; unapproved ones are dropped silently, the
  protocol's omission reasons were not extended); `personalSkillsDisabled` comes from
  `team_skill_settings`; `user.skills` = the owner's personal skills at their latest version (there
  is no per-skill "enabled" state yet), which the resolver omits with `team_disabled` when the
  switch is on. The blocklist stays a stub for KOBE-81.
- **Personal skills fail closed** (coordinator): their scan is stored install-wide
  (`install_skill_scans`, SELECT+INSERT). A flagged or unscanned personal version is unusable in a
  team until that team's admin approves it there: when a member's run first meets it (and the team
  switch is off) a pending `team_skill_reviews` row (`scope = personal`) is created, so it shows in
  that team's queue. Approval in team A does not apply in team B. Unflagged ones need no review.
- **Review rows are self-contained** (slug and hash copied, no FK to versions) so one table serves
  team and personal versions. Queue: sorted and keyset-paged in SQL (`limit` <= 200, `nextCursor`),
  index `team_skill_reviews_queue_idx (team, status, flagged desc, scanned_at)`, findings read only
  for the page.
- **Backfill** (start of 0056, before RLS is enabled, `ON CONFLICT DO NOTHING`): existing team
  versions get pending `unscanned` rows; the queue scans up to 20 of them per listing from the
  stored bundles (`scanUnscanned`). Personal versions without a scan row are treated as unscanned
  the same way (blocked until approved).
- **Web:** `/admin/team/skill-review` (nav entry now READY): switch checkbox, status filter, findings,
  Approve/Reject (confirm when approving a flagged version). Server stays the authority.

## Open questions (for Chris or the coordinator)

- Decided by the coordinator: "open" review mode not built; self-approval allowed (audited).
- The owner is not told when their personal skill is blocked in a team (no omission reason).
- Dropped (unapproved) agent skills give the user no omission notice; needs a new reason in
  `@kobe/protocol` (its own PR).

## Evidence (acceptance criteria -> test or command output)

- ac-1 (flagged/unreviewed skill unusable until approved): `services/server/src/skill-review.db.test.ts`
  (scan, queue, decisions) and `runs-resolver.db.test.ts` ("ac-1": only approved versions resolve).
- ac-2 (disabling personal skills hides them): `runs-resolver.db.test.ts` ("ac-2": `team_disabled`
  omission), switch API in `skill-review.db.test.ts`, UI in `components/admin/skill-review-pages.test.tsx`.
- Probe suite: `pnpm --filter @kobe/db test:db` with the two new tables.
