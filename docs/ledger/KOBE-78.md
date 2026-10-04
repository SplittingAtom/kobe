# KOBE-78: 49a: Skill bundles: tables, versions, zip and SKILL.md upload API

- **Status:** in review
- **Branch / worktree:** `kobe-78-skill-bundles` in `../Kobe-wt78`
- **Depends on:** KOBE-46 (version model), KOBE-27 (object store). Scanner (KOBE-79) not called.

## Plan

Tables and migrations first, then the pure bundle validator, then store and routes, each with
tests written first.

## Decisions

- **Tables** (`packages/db/src/schema/skills.ts`, tenancy in `tenancy/agents.ts`, probe fixtures in
  `probe-fixtures/agents.ts`): team `team_skills` + `team_skill_versions` (RLS, canonical policy);
  install-wide `install_skills` + `install_skill_versions` for personal skills (owner filter in the
  server, grants: skills all, versions SELECT+INSERT). No gallery scope for skills.
- **Migrations:** `0050_skills` (tables) and `0051_skills_rls` (RLS, policies, immutability
  trigger `skill_versions_immutable`, same shape as `agent_versions_immutable`).
- **Versions are immutable:** the trigger refuses UPDATE and direct DELETE; a skill with versions
  can't be deleted (NO ACTION FK); the team cascade still works. No `current_version` pointer:
  `latest_version` on the skill row is bumped under a per-location advisory lock, so numbers are
  consecutive.
- **Scan results and review status are not in these tables.** They are mutable and the trigger
  refuses every UPDATE, so KOBE-80/81 should add their own tables (`skill_scans`, review rows)
  keyed by (skill, version) rather than loosen the trigger.
- **Slug = frontmatter `name`** (lowercase, digits, hyphens, up to 64). An upload with an existing
  name is the next version of that skill; identical bytes to the latest version are `unchanged`
  (409), like agent publishes.
- **Bundle bytes:** always a zip in S3 at `<prefix>skills/teams/<team>/<sha256>` or
  `<prefix>skills/users/<user>/<sha256>`, content-addressed and derived server-side
  (`skills/storage.ts`). `content_hash` is the SHA-256 of exactly those bytes. A bare SKILL.md
  upload is wrapped into a deterministic one-file zip (fixed mtime) so consumers (KOBE-81/82)
  handle one format. The object is written before the DB transaction; a failed commit leaves an
  unreferenced blob that an identical retry reuses. No cleanup job (see open questions).
- **Validation** (`skills/bundle.ts`, own strict central-directory reader `skills/zip-entries.ts`,
  limits in `skills/limits.ts`): upload at most 5 MiB, 200 files, 25 MiB uncompressed in total,
  10 MiB per file, SKILL.md at most 100 KiB, 240-byte paths; ratio above 100:1 is refused once an
  entry or the bundle exceeds 1 MiB. Refused: absolute paths, `..`, `.`/empty segments,
  backslashes, control characters, drive letters, case-insensitive duplicates, symlinks (unix mode
  bits), encrypted entries, zip64, multi-disk, methods other than store/deflate. Declared sizes are
  bounds: every entry is inflated with its declared size as a hard stop, so a lying header is
  refused. SKILL.md must sit at the zip root (no wrapper directory) with YAML frontmatter `name`
  and `description` (core schema, few aliases).
- **API** (`routes/skills.ts`, one `api.route("/skills", ...)` line): `POST /v1/skills?scope=team|personal`
  (zip as `application/zip`, bare file as `text/markdown`), `GET /`, `GET /:id`,
  `GET /:id/versions`, `GET /:id/versions/:n`. Team uploads need `team.skills.publish` (builder),
  personal need `team.personal.create` (member). Responses never expose `storageKey`. 503
  `skills_unavailable` when no S3 is configured (`deps.blobs`).
- **Audit:** `skill.uploaded` (scope `any`; team view for team skills; ids, slug, version, hash,
  sizes, source; documented in `docs/audit-log.md`).
- `RawBody` in `testing/browser.ts` now accepts bytes.

## Open questions (for Chris or the coordinator)

- Orphan blobs: a validated upload whose DB write is refused (`unchanged`, caps, crash) leaves a
  content-addressed object. Fine at these sizes; a sweep belongs with KOBE-81/82 if wanted.
- Wrapper directory in zips (`my-skill/SKILL.md`, what many tools produce) is rejected for now.
  Say so if materialization (KOBE-82) should accept and strip a single top-level folder.
- No per-user upload rate limit yet (agents have one); the version cap (500) and 5 MiB body limit
  are the only brakes.

## Evidence (acceptance criteria -> test or command output)

- ac-1 (upload creates a new version; immutable): `services/server/src/skills.db.test.ts`
  ("makes each changed upload a new immutable version...") and
  `packages/db/src/skills.db.test.ts` ("skill versions are immutable", trigger catalog).
- ac-2 (probe suite green): `pnpm --filter @kobe/db test:db` includes the cross-team probe with
  the four new tables (fixtures added); all green.
- Validator: `services/server/src/skills/bundle.test.ts` (29 cases).
