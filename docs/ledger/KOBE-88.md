# KOBE-88: 50b: Bake six gallery skills into the sandbox image

- **Status:** in review
- **Branch / worktree:** `kobe-88-gallery-skills-image` in `../Kobe-wt88`
- **Depends on:** KOBE-82 (materialization, `--skill` registration, hello capabilities)
- **Migrations:** none.

## Decisions

- **Six skills as SKILL.md bundles** in `images/sandbox/skills/<name>/` (data-analysis, charts, docx, pdf,
  xlsx, code-review), each with `scripts/*.py` helpers and a tiny sample input used by the image test.
  Scripts are run as `python scripts/x.py` (no exec bit; the image strips none, files are 0444).
  Frontmatter descriptions are double-quoted (they contain `: `, which plain YAML scalars can't).
- **Baked, not fetched.** `COPY` to `/opt/kobe/skills` (the existing root-owned image dir), then
  `chown 0:0`, dirs 0555, files 0444: nothing writable by the agent (1000), Pi (2000+) or tools. The
  image sets `KOBE_BUILTIN_SKILLS_DIR=/opt/kobe/skills`. Separate from KOBE-82's `KOBE_SKILLS_DIR`
  store, which stays the only place fetched bundles live.
- **Registration is per run.** New additive `run.start.config.builtin_skills: [name]` (enum of the six,
  `packages/protocol/.../skill-bundles.ts`, `BUILTIN_SKILL_NAMES`). The agent registers exactly those
  with Pi (`--skill <dir>`, builtins first, then KOBE-82 store skills) and the list is part of Pi's launch
  key. Unlisted built-ins are never registered (`--no-skills` stays). A run naming a built-in that the
  image lacks fails `pi_unavailable`.
- **Capability gate.** `hello.capabilities` gains `builtin_skills`, advertised when
  `KOBE_BUILTIN_SKILLS_DIR` is set. The server fails a run with `builtin_skills` on an agent without it
  (`skills_unsupported`, same as bundles). Rollout order unchanged: server first.
- **Resolver.** Built-in names are reserved install-provided names. In `loadSkillFacts` they are split
  from the agent's names before the team lookup (never `not_approved`, never matched to a team skill of
  the same name); `resolveEffective` returns `builtinSkills` (deduplicated). They have no hash, so the
  blocklist (hash-keyed) cannot hit them. A personal skill with the same name as a listed built-in is
  `shadowed_by_agent`. `config.skills`/`skill_bundles` still carry only fetched skills.
- **Exclusion by name:** the resolver has none for agent skills, so none for built-ins. An agent just
  doesn't list a built-in; an exclusive agent keeps those it lists. Not blocklistable by hash (by design).
- **Libraries:** all six use the existing stack plus `pypdf==6.19.0` (BSD-3-Clause, pure Python, no
  dependencies on 3.12) for PDF text and page ops, locked with hash in `requirements.txt`. No license
  exception needed. Offline by construction: no script opens a socket.
- Not done here (KOBE-87): attaching built-ins to gallery agents. An agent listing a built-in name
  already resolves it (db test).

## Open questions

- No OCR or spreadsheet recalculation in the image: documented in the pdf and xlsx skills.
- Old sandbox images (no `builtin_skills` capability) fail runs that list built-ins; roll out the image
  before attaching gallery agents.

## Evidence

- ac-1 (each skill runs with egress blocked): `images/sandbox/test-image.sh`, check "no skill script needs
  the network" runs every sample script under `--network none` (PNG, docx, pdf, xlsx, SQL result, scan);
  also read-only/root-owned checks and a Pi-uid write-denied check.
- ac-2 (image checks + Trivy stay green): test-image.sh run on the remote Docker host, CI
  `sandbox-image.yml` (see PR).
- Tests: `services/sandbox-agent/src/agent.skills.test.ts` (only listed built-ins registered, capability),
  `services/server/src/resolver/resolve.test.ts`, `skill-materialization.db.test.ts`.
