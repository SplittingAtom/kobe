# KOBE-587: PC-0 Remove restricted project visibility (every member reads every project)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in progress (committed on the branch; coordinator reviews, PRs and merges)
- **Branch / worktree:** `kobe-587-remove-restricted` in `../Kobe-wt587`
- **Depends on:** KOBE-577..583 (Workspaces, merged). Spec: `docs/specs/projects-in-conversations.md`
  §7 RV1-RV4 (replaces workspaces PR2, PR3's visibility branch, PJ1/PJ2's reader rows, MG2's
  visibility column).

## Plan

1. DB: migration `0202_restricted_removal` (hand-written around drizzle's statements, as 0201):
   lift FORCE on `project_members`, drop the role check, delete `reader` rows, check
   `IN ('owner','editor')`, restore FORCE; drop `projects_visibility` and `projects.visibility`.
   Schema in `packages/db/src/schema/projects.ts` (the projects tables live there, not in a
   `tenancy/<area>.ts`). No RLS policy, SQL function or view read `visibility` (checked
   `drizzle/*.sql`), so none changes; FORCE RLS stays.
2. CLI dry-run `kobe projects restricted [--json]` (packages/cli).
3. Protocol, server routes, OpenAPI.
4. Web; docs (audit log, install upgrade note); browser specs.

## Decisions

- **`member_user_ids` on create stays**, no longer tied to `restricted`: the listed people become
  editors (smallest consistent reading; the web no longer sends it).
- **Effective role:** `effectiveProjectRole(explicit) = explicit ?? "reader"`;
  `projectPermissions(teamRole, explicit)` lost its visibility argument (also
  `canAddToProject`). Server `decide()` returns no role for an **unlisted team admin**, so
  `my_role` is `null` for them in every project (PR3 "my_role null, as today"); before, a
  workspace-visible project answered `reader` to an unlisted admin and the web's Files panel then
  showed it read-only. Web follow-ups of that: the memory project picker lists every project and
  the project page's "Project memory" link shows for every viewer (`can.view`).
- **PATCH /members/{user}** on a workspace member without a row adds an owner/editor row (as
  PJ2 did for implicit readers); **DELETE** makes them an implicit reader again. Re-roling to
  reader is a 400 (body schema), so "make reader" = remove the row.
- **`viewableBy` (SQL)** is now "member of the project's team"; `memberProjectIds` uses it.
- **Audit:** `project.created` no longer carries `visibility`; `project.member_role_changed`
  `roles` counts owner and editor only. The db event schemas keep `visibility` and `reader`
  optional so older rows still validate; `project.visibility_changed` stays defined (retired, rows
  stay) and leaves the protocol's list of written lane events (`PROJECT_AUDIT_EVENTS`).
- **Dry-run** reads with the backup role (`KOBE_BACKUP_DATABASE_URL`, BYPASSRLS or superuser,
  refused otherwise since FORCE RLS would show nothing), in one `READ ONLY` transaction; output
  is team slug/name, project slug/name (archived marked), members with role and email, reader
  rows marked "[row deleted]"; after the migration it says the migration already ran.
- **workspaces-upgrade.db.test.ts** now migrates to the release before 0202 (`migrationsBefore`
  on 0202's DROP COLUMN), so its MG2 assertion on `visibility` still checks 0201.
- **OpenAPI:** the document only covers project-commits routes (no project CRUD shapes), so the
  regeneration changed the 404 description only.
- **Server tests whose premise was "a team member outside a restricted project gets 404"** now use
  a user of another workspace for the 404, and assert that an unlisted member reads. Tests whose
  behaviour is gone were rewritten to the new rule: narrowing a team share to the project no longer
  ends a reader's stream (dropped from the stream test), a thread marker always names the project,
  a remembered approval holds in any project of the workspace, losing a row keeps a reader's mount.
- **Help text** (RV4) sits above the New project form; there is no other place that creates
  projects in the web today (KOBE-586 will add one).

## Open questions (for Chris or the coordinator)

- Project vs team share scope now have the same audience (every workspace member). Both stay as
  the spec keeps them; worth a line in the gate doc.
- The dry-run must be run on gate1 **before** deploying this build (lane brief: list goes in the
  gate doc; take the `pg_dump` first).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `packages/db/src/restricted-removal-upgrade.db.test.ts` (populated db: restricted project
  with owner, editor, reader → column and check gone, reader rows deleted, owners/editors kept,
  `reader` refused by the check, FORCE RLS kept, app role sees its own team only);
  `@kobe/db test:db` for projects, probe, both upgrade tests: 782 + 5 passed. `db:check`: no changes.
- **ac-2** `packages/cli/src/restricted-projects.db.test.ts` (pre-0202 db: lists every restricted
  project of every team with members, changes nothing; migrated db: says so),
  `restricted-projects.test.ts`, `config.test.ts`; `@kobe/cli test` 95 passed.
- **ac-3** `services/server/src/project-roles.db.test.ts` (unlisted member reads files, members,
  memory, shared threads, converses, no 404; other workspace 404; reader role 400 on POST/PATCH;
  PATCH promotes an implicit reader; visibility 400 on create/update; no visibility_changed),
  `projects.db.test.ts`; 22 changed server db files: 279 passed. `@kobe/server test` 2549 passed.
  `openapi.json` regenerated (`UPDATE_OPENAPI=1`).
- **ac-4** `apps/web/components/projects/projects.test.tsx`, `project-roles.test.tsx` (no
  Visibility control, no Restricted text, role options owner/editor, help text on create).
- **ac-5** `docs/audit-log.md` marks `project.visibility_changed` retired;
  `e2e/browser/tests/workspaces.spec.ts` (member2 a reader by default) and
  `add-to-project.spec.ts` updated. Full `pnpm verify` not run here (memory limit; coordinator).
