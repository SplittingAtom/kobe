# KOBE-343: D1: Optional one-way git mirror of the catalog

- **Status:** in progress (group branch `group-40-skills-phase-d`, not pushed)
- **Branch / worktree:** `group-40-skills-phase-d` in `../Kobe-wt343`
- **Depends on:** KOBE-342

## Plan

Server job (`services/server/src/skills/mirror/`) pushes each published catalog version to the
configured HTTPS remote through the egress proxy; status and Retry in the Site console; chart
values for the token Secret and identity; no migration (`registry_versions.mirror` and
`site_skill_settings.mirror` already exist).

## Decisions

- **No migration.** Per-version state lives in `registry_versions.mirror` (the immutability
  trigger already lets it change); the shape is `registryVersionMirrorSchema` (protocol,
  additive: `skill-mirror.ts`). The remote/branch stay the existing `mirror` Registry setting.
- **What is mirrored:** published versions = Approved and Deprecated, not suspended, oldest
  approval first; Kobe-published built-ins included (they are catalog versions). Withdrawn and
  Revoked never pushed; one already pushed stays (append-only). Enabling the mirror, or changing
  the URL, pushes the whole published catalog to that remote (state is per URL).
- **Layout:** commit = remote head + `skills/<name>/` replaced by the package files byte for
  byte (package zip, checked against both recorded hashes before pushing; a mismatch is a version
  error) + `provenance.json` (canonical JSON, only when the stored provenance parses) +
  `skills/.gitattributes` (`* -text`, as docs/skill-package.md promised) + regenerated
  `catalog.json` (name → semver → tag, runtimeHash, packageHash; no people, teams or times).
  Annotated tag `<name>/v<semver>`. Commit trailers `Kobe-Registry-Version`, `Kobe-Runtime-Hash`,
  `Kobe-Package-Hash`.
- **Authorship:** a fixed identity from chart values (`Kobe Registry <registry@kobe.invalid>`
  default) for author, committer and tagger. No reviewer or submitter names or emails in git
  (the mirror is outside Kobe's erasure and retention).
- **Append-only:** commits always build on the fetched remote head (others may push there too),
  pushes never forced (isomorphic-git refuses non-fast-forward and existing tags), an existing
  tag with the same tree counts as pushed (idempotent after a crash or a URL switch back), with
  other content it is a version error ("Kobe never moves a tag"). A commit already on the branch
  for the version (trailer + same tree; crash between branch and tag push) is tagged, not
  recommitted. History read back: 100 commits (shallow fetch).
- **Egress (ac-4):** the egress proxy authenticated sandboxes only. Added a **site egress
  token** (`@kobe/session-token` `site.ts`: aud `kobe.egress-proxy.site`, sub `skill-mirror`,
  exact claims, 5 min, same egress-proxy key the server already holds; neither token kind
  verifies as the other). The proxy accepts it as Bearer on CONNECT only (never plain HTTP),
  decides on the site ceiling alone, skips membership/team allowlist/header injection/run
  reports and the team-scoped `egress.connection` audit (logged to stdout; the server audits the
  push). Site tunnels are re-checked on ceiling changes. Chart: egress-proxy NetworkPolicy admits
  the server pods. Not in `packages/protocol` (no contract change to session tokens).
- **Ceiling is not auto-edited:** the spec says "host added to the egress ceiling"; the Site
  admin adds it (an audited action of its own). The console warns when it is missing; the proxy
  refuses otherwise and the error shows on the version.
- **Credentials:** `server.skillMirror.tokenSecret` → `KOBE_SKILL_MIRROR_TOKEN` via
  `secretKeyRef` (optional: true) on the server only; Basic auth (`username` default
  `x-access-token`) sent only to the remote's own origin; no redirects followed; errors redacted
  (token and its Basic encoding) before storage, audit and logs.
- **Failures:** per version, backoff 1 min doubling to 6 h; a version's own problem (missing or
  corrupt bytes, tag conflict) skips it, a remote/transport failure stops the run and is recorded
  on the oldest pending version. Audit `registry.mirror.pushed` per version,
  `registry.mirror.failed` on the first failure of a streak only, `registry.mirror.retried` for
  the console's Retry now.
- **When:** kicked after each approval and each mirror settings change, swept every 5 min, one
  replica at a time (advisory lock `kobe.skill-mirror`), up to 25 versions per run.
- **New dependency:** `isomorphic-git` 1.44.2 (MIT; deps MIT/Apache/BSD/Zlib), pure JS, so no git
  binary in the server image. `THIRD_PARTY_LICENSES.md` regenerated.

## Review fixes (Opus review)

- **Blocklist (M):** each run first withdraws published versions whose runtime or package hash
  (or hash group, `blockedAmong`) is on the site skill blocklist: status `withdrawn` (pushed
  commit/tag kept in the record), never pushed again (also not to a new remote), left out of
  `catalog.json` from the next commit on; history is never rewritten. Off the blocklist: pending
  again (an existing tag with the same tree counts as pushed; `catalog.json` relists it on the
  next commit). Console shows a withdrawn count. Not separately audited: the blocklist change is.
- **Egress audit (L):** site-job connections are written durably as `egress.site_connection`
  (site scope; job, host, port, outcome, reason, bytes; never a token), aggregated like
  `egress.connection`.
- **Git-reserved paths (L):** `packagePathProblem` refuses `.git`, `.gitattributes` and
  `.gitmodules` segments in any case at any depth (`git_reserved`, for every package, not only
  the mirror); case-folded collisions were already `duplicate`. The mirror's per-version error
  names the paths and problems.
- **provenance.json IDs (L):** checked against spec line 251 (source scope and version,
  submitter, scan, scorecard numbers, both hashes). The ids (`source.teamId`, `source.skillId`,
  `submitter.userId`, `confirmedBy.userId`) are Kobe's lowercase UUIDs (`UUID_PATTERN`); the
  mirror writes the stored provenance only when it parses with `provenanceSchema`, as canonical
  JSON. The spec doesn't specify an id format; ids, no names or emails, reach the mirror.

## Open questions (for Chris or the coordinator)

- "Tested against Forgejo and GitHub": covered here by a local `git http-backend` (smart HTTP,
  non-fast-forward and deletes refused) over HTTPS through a CONNECT proxy; a live run against
  a Forgejo and a GitHub repository on gate1 is still to do (needs a token Secret and the host in
  the ceiling).
- Forgejo Basic auth with a token: the user name may need to be the token owner
  (`server.skillMirror.username`); confirm on the live run.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/skill-mirror.db.test.ts` "pushes each published version…" and
  `skills/mirror/git-mirror.test.ts` (tag tree read back with the git CLI re-hashes to the
  version's runtime and package hashes; annotated tags; linear history).
- ac-2: `git-mirror.test.ts` "builds on commits others pushed and never moves a tag…",
  "is idempotent…", "tags a commit already on the branch…"; DB test "backs off a failing
  version…" (backoff, console failures, single audit, Retry now) and "stops on a remote
  failure…" (token redacted); web `skill-registry-page.test.tsx` mirror status.
- ac-3: DB test "does nothing while off" (no rows changed, no request to the remote) and web
  "asks nothing of the mirror while it is off".
- ac-4: `skills/mirror/http-client.test.ts` (push over TLS through a CONNECT proxy with the site
  token), egress-proxy `proxy.test.ts` "site jobs (KOBE-343)" + tunnel re-check,
  `auth.test.ts`, `allowlist.test.ts`; session-token `site.test.ts`; chart `skill-mirror.test.ts`
  (token on the server only) and `egress.test.ts` (server admitted to the proxy).
