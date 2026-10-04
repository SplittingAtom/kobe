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
- **Personal skills are not reviewed**: they are install-wide, run only for their owner, and no team
  owns them. They are scanned (findings counted in the upload audit) but not stored.
- **Web:** `/admin/team/skill-review` (nav entry now READY): switch checkbox, status filter, findings,
  Approve/Reject (confirm when approving a flagged version). Server stays the authority.

## Open questions (for Chris or the coordinator)

- Should personal skills with findings be blocked or shown to the owner? Today only team skills
  need review (spec text says "team skills require team-admin review").
- Add a team setting for the "open" alternative (no review for unflagged skills)? Not built.
- Reviewers can approve their own uploads; two-person review would need a rule from the spec.
- Dropped (unapproved) agent skills give the user no omission notice; needs a new reason in
  `@kobe/protocol` (its own PR).

## Evidence (acceptance criteria -> test or command output)

- ac-1 (flagged/unreviewed skill unusable until approved): `services/server/src/skill-review.db.test.ts`
  (scan, queue, decisions) and `runs-resolver.db.test.ts` ("ac-1": only approved versions resolve).
- ac-2 (disabling personal skills hides them): `runs-resolver.db.test.ts` ("ac-2": `team_disabled`
  omission), switch API in `skill-review.db.test.ts`, UI in `components/admin/skill-review-pages.test.tsx`.
- Probe suite: `pnpm --filter @kobe/db test:db` with the two new tables.
