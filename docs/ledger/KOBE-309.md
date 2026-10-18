# KOBE-309: A3: Contract: skill package, kobe.skill.yaml, provenance and hashing rules

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (contract; group branch, Skills v1.2 Phase A). Nothing builds on it yet.
- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`
- **Depends on:** KOBE-308 (same branch). Dependants: KOBE-310, 317, 333.

## Plan

Contract only: `packages/protocol/src/skill-package/` (layout, canonical zip, manifest and
provenance schemas), `@kobe/protocol/node` hashes, golden vectors (`@kobe/protocol/testing`),
golden fixtures, `docs/skill-package.md`. No server implementation (`bundle.ts` unchanged); a
server test proves the contract equals today's stored hashes.

## Decisions

- **Canonical zip specified byte by byte** and written dependency-free in protocol (CRC-32 and
  headers by hand), so any tool can reproduce it without fflate. It is byte-identical to the
  server's KOBE-78 repack, including one quirk now written into the contract: root names that are
  JS array indices (`9`, `10`) sort first, numerically (fflate takes an object). Kept rather than
  "fixed", because fixing it would change existing `content_hash` values.
- **provenance.json is outside both hashes** (it records them; including it would be circular).
  The brief's "package hash = everything" therefore means everything but `provenance.json`.
- **Runtime payload also excludes a root `provenance.json`**; ac-2 holds for any bundle without
  the three reserved root names. A legacy upload that happens to have one keeps its stored hash
  (nothing is recomputed); 310 decides whether new uploads may still carry those names.
- Only root names are reserved (`scripts/evals/x` is payload); a file named `evals` is refused.
- **Manifest**: strict (unknown keys refused, so `allowedTools` or similar can't sneak in);
  `name`/`version` must match SKILL.md and the saved semver (`manifestMismatches`); `license`
  optional in drafts (SK20 requires it at submission); `maintainers` a request only (SK24);
  egress hosts exact (no wildcards, as the team egress list). YAML text rules: 16 KiB, YAML 1.2
  core, unique keys, no aliases (`MANIFEST_YAML_OPTIONS`); `yaml` is a protocol devDependency
  for the fixture tests only (already in the tree, ISC, listed).
- **Provenance**: strict; scan findings are locations only (no excerpts); scorecard numbers
  only, tied to a package hash (`provenanceMismatches` flags a stale one); origin URLs https.
- Semver pattern shared with KOBE-308 (`SEMVER_PATTERN`, 9 digits a part).

## Open questions (for Chris or the coordinator)

- Confirm `provenance.json` outside both hashes (and outside the runtime payload).
- Confirm the array-index ordering quirk is kept as contract rather than changing hashes.

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/protocol/src/skill-package/skill-package.test.ts`: 3 valid + 12 invalid
  manifest fixtures (each invalid one pinned to the field it fails on), 2 valid + 7 invalid
  provenance fixtures, mismatch checks.
- ac-2/ac-4: `services/server/src/skills/package-hash.test.ts`: uploads of every vector
  (deflated, reordered, wrapped) repack to the contract's bytes and hash in 4 timezones; a bare
  SKILL.md too. Independently checked against fflate before pinning.
- ac-3: `SKILL_HASH_VECTORS` (5 vectors: SKILL.md only, payload, full package, provenance change,
  ordering/UTF-8/empty file) with pinned hashes; timezone and input-order tests.
