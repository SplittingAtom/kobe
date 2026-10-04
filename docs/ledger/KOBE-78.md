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
- **Bundle bytes and hash (for KOBE-81/82):** the uploader's zip is never stored. After validation
  it is repacked into a **canonical zip**: regular files only (no directory entries), paths
  NFC-normalized and sorted, stored without compression (so bytes never depend on a deflate
  implementation), fixed timestamp (built from local fields, so timezone-independent), no extra fields, comments or attributes. `content_hash` is the
  SHA-256 of exactly those bytes, which are what S3 holds at
  `<prefix>skills/teams/<team>/<sha256>/<attempt-uuid>` (or `users/<user>`) (derived
  server-side, `skills/storage.ts`). Recompressing, reordering, commenting, junk-prefixing,
  wrapping in one top-level folder or NFD paths do not change the hash. A bare SKILL.md is wrapped
  the same way. On any failure after the write the attempt's own object is deleted best-effort
  (keys are unique per attempt, not content-addressed, so cleanup can't touch a committed
  version's blob or a concurrent identical upload's); a failed delete logs the key. Uploads: 30 per user per 10 minutes
  (`hitRateLimit`, 429).
- **Validation** (`skills/bundle.ts`, own strict central-directory reader `skills/zip-entries.ts`,
  limits in `skills/limits.ts`): upload at most 5 MiB, 200 files, 25 MiB uncompressed in total,
  10 MiB per file, SKILL.md at most 100 KiB, 240-byte paths; ratio above 100:1 is refused once an
  entry or the bundle exceeds 1 MiB. Refused: absolute paths, `..`, `.`/empty segments,
  backslashes, control characters, drive letters, case-insensitive duplicates, symlinks (unix mode
  bits), encrypted entries, zip64, multi-disk, methods other than store/deflate. Declared sizes are
  bounds: entries are inflated in 16 KiB steps and aborted the moment the declared size or the
  bundle-wide budget is crossed; a compressed size above declared+0.1%+64 is refused. Any mode
  type other than regular file or directory is refused whatever OS the archive claims;
  duplicates are judged after NFC + lowercase; a `__proto__` path segment is refused. Frontmatter is capped at 16 KiB (half the DB check,
  since jsonb text grows up to 1.5x). SKILL.md must sit at the zip root, or every entry must sit under one single top-level
  directory (stripped before lookup; two top-level dirs or a file beside it are refused), with YAML frontmatter `name`
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

- A failed delete leaves an orphan object (logged by key); a sweep is optional.

## Evidence (acceptance criteria -> test or command output)

- ac-1 (upload creates a new version; immutable): `services/server/src/skills.db.test.ts`
  ("makes each changed upload a new immutable version...") and
  `packages/db/src/skills.db.test.ts` ("skill versions are immutable", trigger catalog).
- ac-2 (probe suite green): `pnpm --filter @kobe/db test:db` includes the cross-team probe with
  the four new tables (fixtures added); all green.
- Validator: `services/server/src/skills/bundle.test.ts` (29 cases).
