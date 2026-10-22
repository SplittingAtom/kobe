# KOBE-344: D2: Governed import from allowlisted git hosts

- **Status:** in progress (group branch `group-40-skills-phase-d`, not pushed)
- **Branch / worktree:** `group-40-skills-phase-d` in `../Kobe-wt343`
- **Depends on:** KOBE-342; reuses KOBE-343's site egress token and HTTP client

## Decisions

- **Migration (the brief said none):** a draft had nowhere to keep an origin (`parent_ref` is
  fork-only by a check). `skill_drafts.origin jsonb` (0174), set for every `git` draft and for an
  `upload` draft from a zip URL, only those; frozen by the guard trigger like `started_from` and
  `parent_ref` (0175, custom). Own first commit; db tests green.
- **Allowlist "hosts and organizations":** the existing `importAllowlist` setting now takes
  `host` (any repository there) or `host/owner` (only that owner, case-insensitive). Subdomains
  are never implied; default empty = no imports. Additive protocol change.
- **Who:** Builders and Team admins (`team.skills.publish`); members can't import (the spec says
  Builders). Same rate limit as uploads.
- **Git:** URL https, default port, no credentials, query or fragment; a full 40/64-hex commit,
  never a ref. isomorphic-git can't fetch a bare SHA, so the server fetches every branch and tag
  (bounded at 64 MiB of responses) and reads that exact commit; a commit no branch or tag reaches
  is refused (conservative: no `allowAnySHA1InWant` assumptions). Optional folder. Files only:
  symlinks and submodules refused; no hooks, no checkout.
- **Zip:** the request must pin a SHA-256 (conservative, parallel to the git SHA); one GET, no
  redirects, at most the upload cap; the bytes must hash to the pin.
- **Re-hash and checks:** package path rules first (git-reserved names, case collisions,
  authored provenance.json, SKILL.md), then the upload validation of the canonical zip, then the
  draft caps (5 MiB, 200 files). `origin.fetchedSha256` is Kobe's own hash: the zip's bytes, or
  the canonical zip of the imported git files.
- **Egress:** through the egress proxy with a site egress token, purpose `skill-import`
  (allowed ceiling hosts only); site-job connections audited as `egress.site_connection`. The
  allowlist host must also be in the ceiling (the console hint says so).
- **Result:** a private Workbench draft (`started_from` git, or upload for a zip) with origin;
  never a catalog entry. `skill.draft.created` audit carries the origin. Nothing is fetched
  after creation (ac-4): the draft holds the files.

## Open questions (for Chris or the coordinator)

- The origin lives on the draft only; it does not yet flow into a saved version or into
  `provenance.json`'s `origin` at promotion (needs version columns: a later migration).
- Public hubs as "discovery links": no links are shown in the UI yet.
- Live check against GitHub/Forgejo (fetch through the egress proxy) still to do on gate1.

## Evidence (acceptance criteria → test)

- ac-1: `services/server/src/skill-import.db.test.ts` "refuses everything by default…";
  protocol `skill-import.test.ts`.
- ac-2: DB test "imports a commit's folder… whatever main says later", "refuses unknown
  commits…", zip `hash_mismatch` and redirect refusal.
- ac-3: DB test draft `origin`, audit row; `packages/db` `skill-drafts.db.test.ts` origin checks
  and freeze.
- ac-4: DB test (no proxy connection after creation); design (no fetch path outside creation).
- Web: `apps/web/components/skills/starts.test.tsx` "Import (KOBE-344)".
