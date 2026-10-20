# KOBE-332: C3: Names and maintainers

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-330/331, KOBE-311 (`registry_skills`, `registry_maintainers`)
- **Migrations:** none (the tables, the unique name and Kobe's reserved names are 0133's)

## What shipped

- **Names** (`skills/registry/names.ts`, `names-db.ts`): `isReservedName` (Kobe's seven),
  `similarNames` (same name without `-`/`_`, or Levenshtein ≤ 1 for names ≤ 5 characters, ≤ 2
  otherwise; never the name itself) and `similarCatalogNames`; reviewers read them at
  `GET /v1/site/skills/registry/similar?name=` (`requireSkillReview(queue.read)`). A hint, never a
  block. The database keeps the namespace flat (`registry_skills_name_unique`) and Kobe's names
  Kobe's (`registry_skills_kobe_names`).
- **Submission right** (`submissionRight(tx, name, userId)`, for KOBE-333's promotion): a Kobe
  name is `reserved`; a new name is free; an existing skill only for its active maintainers, or,
  before its first approval (no maintainers), for whoever submitted it (`taken` for others); an
  archived name is refused. Others get "<name> is maintained by A, B; fork it under a new name or
  ask to be added."
- **Maintainers** (`skills/registry/maintainers.ts`, routes `/v1/skills/catalog/:skillId/maintainers`):
  anyone signed in reads them (the catalog is Site-wide); active maintainers and Site admins add
  (active users, at most 20) and remove (never the last active one: 409 `last_maintainer`); Site
  admins replace the list (`PUT`). Kobe's skills are Kobe's (403). Audited
  `skill.maintainer.added/removed`, `skill.maintainers.reassigned`.
  `recordFirstMaintainer(tx, skillId, userId)` is the hook for the approve transaction (the review
  ticket): the first approved submitter becomes the first maintainer (audited, system actor).
- **Unmaintained:** a `deactivated` lifecycle hook marks every active skill whose last active
  maintainer this was `unmaintained` (audited `skill.catalog.unmaintained`, system) and emails the
  Owner and active Site admins; a `reactivated` hook, adding a maintainer or a reassignment makes
  it active again (`skill.catalog.maintained`). The skill keeps working throughout.
- **Web:** the Site console's Catalog skills table shows an **Unmaintained** badge and a
  **Maintainers** panel per maintainer-published skill (list, add, remove).

## Decisions

- Members manage maintainers through the API only for now: the member-facing catalog detail page
  (SK25) is a later ticket and gets the same panel.
- A deprecated skill whose maintainer leaves stays deprecated (only `active` becomes Unmaintained).

## Review fixes (review-c2.md)

- C3-M1 (coordinator): an Unmaintained skill (maintainer rows, none active) refuses every former
  maintainer with `unmaintained` until a Site admin reassigns it; the pre-approval branch needs no
  maintainer rows at all (`skill-maintainers.db.test.ts`). C3-M2 (freeing names) is KOBE-334's.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skills/registry/names.test.ts`; `skill-maintainers.db.test.ts`
  "names": reserved, taken, the maintainer message, pending first version, database refusals;
  reviewer-only hints.
- **ac-2** same DB file "maintainers": who may change them, never the last, reassign, Kobe's
  skills, audit rows with actors; web `apps/web/components/admin/skill-tags-page.test.tsx`.
- **ac-3** same DB file "Unmaintained": deactivation through the Site users route marks it,
  audits and emails Site admins; reactivation restores it.
