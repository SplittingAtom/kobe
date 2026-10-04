# KOBE-81: install skill hash blocklist

Status: PR open (branch `kobe-81-skill-blocklist`). Migration `0057_easy_jack_power` (one table).

## Decisions

- **Table `skill_blocklist`** (install-wide, no team data): `content_hash` PK (CHECK `^[0-9a-f]{64}$`,
  the SHA-256 of the canonical repacked zip from KOBE-78), `reason` (1-500 chars), `added_by` (FK
  users), `added_at`. It was already listed in `tenancy/agents.ts`; grants are SELECT, INSERT,
  DELETE (no UPDATE: entries are added or removed). No RLS (install-wide); the wall is the route:
  `requireInstallPermission("install.blocklist.manage")` (install admin and owner).
- **No cache.** Every enforcement point queries the table inside its own transaction, so a new entry
  applies on the next request/run start in every team and to versions uploaded earlier.
- **Enforcement points** (`skills/blocklist.ts` holds the reads):
  - Upload: `uploadSkillVersion` checks inside the upload transaction (after the location lock);
    blocklisted: 422 `skill_blocklisted`, the attempt's blob is discarded like any failed upload.
    Applies to team and personal uploads.
  - Review queue: `decideReview` refuses `approved` for a blocklisted hash (409
    `skill_blocklisted`); `rejected` is still allowed, so admins can clear the queue. After removal
    from the list the version can be approved again.
  - Run start: `loadSkillFacts` returns `blockedHashes` (the hashes among the agent's approved team
    skills and the user's usable personal skills that are listed), `buildResolveInput` passes them
    on (replaces `TODO(KOBE-81)`), and the resolver's existing `blocklisted` omission drops them
    (visible notice to the user). A blocked newest version does not fall back to an older approved
    version: the skill is omitted, so a malicious hash can't be silently swapped for another one.
  - Materialization (KOBE-82) must take its skill list from the resolver output; it has no other
    source, so a blocklisted hash never reaches a sandbox.
- **Hash input**: 64 hex in any case, trimmed by the UI, lowercased by the API (also on DELETE).
  Duplicate add: 409 `already_blocked`. Remove of an unlisted hash: 404.
- **API** `/v1/install/skill-blocklist`: `GET ?limit&cursor` (newest first, keyset on
  `(added_at, hash)`, default 50, max 200), `POST {contentHash, reason}`, `DELETE /:hash`.
- **Audit**: `skill.blocklist.added` / `.removed` (scope install, target is the hash only; the
  reason stays in the table, never the bundle). Documented in `docs/audit-log.md`.
- **UI**: the existing install nav entry `skill-blocklist` is now `READY`; page
  `components/admin/install/skill-blocklist-page.tsx` (form with hash + reason, table, Load more,
  remove with confirm).

## Evidence

- `services/server/src/skill-blocklist.db.test.ts`: upload rejected in both teams and as personal
  (nothing stored); queue refuses approval but allows reject, approves again after unblock;
  resolver omits a team skill in two teams the moment it is listed and restores it on removal;
  personal skill omitted in every team; admin-only (403 for team admin/builder); validation, case
  normalization, duplicate, 404s; paging; audit rows carry only the hash.
- `apps/web/components/admin/skill-blocklist-page.test.tsx`: list + paging, block (lowercased),
  remove, server error shown.

## Open questions

- Should the team review queue also show a "blocklisted" badge on affected rows? Not done: the
  approve error already names the cause.
- Fall back to an older approved version when the newest is blocked? Chosen: no (see above).
