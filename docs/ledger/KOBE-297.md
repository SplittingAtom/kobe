# KOBE-297: Skills visibility: "Used skill" badge, team skills offered to all agents, picker origin

- **Status:** done on branch, awaiting the coordinator's Opus review (resolver + detection); no PR (group G3)
- **Branch / worktree:** `group-3-phase-c-org` in `../Kobe-g3`
- **Depends on:** KOBE-82 (materialization), KOBE-88 (built-ins), KOBE-80/99 (review), KOBE-209 (markers)

## Commits

1. `feat(db)`: migration **0101_skills_reach** (generated, own first commit): `runs.skill_refs`,
   `runs.skills_used` (jsonb, default `[]`), `team_skills.offer_to_all` (bool, default false).
   Expand-only, constant defaults (metadata-only), no new table, no RLS or probe change.
2. `feat(server)`: detection, storage, resolver offer, routes. 3. `feat(web)`: badges, skill page, picker.

## Decisions

- **Detection (ac-1)** is on the server, in the ingest's batch transaction
  (`sandbox-wire/ingest.ts` → `skills/usage.ts` `recordSkillUsesInTx`, pure matching in
  `skills/detect.ts`). A use = a `tool.result` of `read` with `is_error: false` whose `tool.call`
  input `path` is absolute and, after `posix.normalize`, equals exactly
  `/run/kobe-skills/store/sk-<sha256>/SKILL.md` for a bundle in the run's own refs, or
  `/opt/kobe/skills/<name>/SKILL.md` for a built-in the run lists. Workspace paths, relative
  paths, other files of the skill, forged hashes, failed reads and any sandbox label never count.
  The call's input comes from the same batch, else from the run's stored `tool.call` event.
- **The run's refs** come from `run.start` itself (`bundleRefsFor` + built-ins), recorded with the
  run as `runs.skill_refs` in the run-start transaction (`lifecycle.ts`, `PINNED_AGENTS` returns
  them with their source); a recovery restart re-resolves and replaces them. `sandbox_commands`
  rows are deleted right after the start is answered, so the frame can't be read mid-run.
- **Storage: run columns, not an event or an entry annotation.** `run_events` is compacted after
  7 days (D18), so an event badge would vanish on reload later; Pi's mirrored entries are verbatim
  Pi documents. The run row is already locked and updated by the same ingest transaction (CAS on
  `sandbox_seq`), outlives the event stream, and the markers endpoint already places run-keyed
  things by (`user_entry_id`, `tool_call_id`). Cap 64 uses per run. No protocol change: the chat
  reads `skills` from `GET /v1/threads/{id}/markers` on open, after each run and after each
  successful `read` result (so the live answer gets the badge within the run).
- **Usage (count, agents, last used):** aggregated from `runs.skills_used` of the team's last 90
  days (`GET /v1/skills/{id}/usage`): team skills to their owner and team admins, personal ones to
  their owner (own runs only). Other members' personal agents are counted without a name.
- **Offer to all (ac-2):** `resolveSkills` adds the team's offered skills (newest approved
  version, as for named ones; `loadSkillFacts` reads them in the run-start transaction and the
  blocklist covers their hashes) after the agent's and the user's skills, to non-exclusive agents
  only, skipping a name already present (named, built-in, or a used personal skill; one hidden by
  the team switch is filled by the offer). No omission notice for an offered skill that is left
  out (the agent never named it). Team-scoped by RLS and an explicit `team_id`; scheduled runs use
  the same `PINNED_AGENTS` path. Only team admins switch it (`PUT /v1/skills/{id}/offer`, audited
  `skill.offer.changed`).
- **Skill page:** `GET /v1/skills/{id}/reach` lists the team's agents, the gallery and the caller's
  own personal agents with `via` (named / offer / none) and `canEdit` (team agents, `agentAccess`).
  "Add to agent…" opens `/admin/team/agents/<id>?addSkill=<slug>`: the builder adds the slug to the
  draft's skills unsaved and says so. The rule sentence (`lib/admin/skills/reach.ts`) is on the
  editor's scope hint, the skill page and the review page.
- **Picker (ac-3):** each option shows Built-in / Team / Personal; equal name and origin adds the
  slug; the button names the origin when the name is shared (`lib/chat/agent-origin.ts`).

## Review (Opus, approve with H1) and fixes

- H1: a run carries at most 64 skills (`RUN_SKILLS_MAX` = protocol `SKILL_BUNDLES_MAX`): named,
  then personal, then offered (sorted by name); the rest are omitted with the new
  `context.omitted` reason `skill_limit` (protocol enum, additive; web text). A team offers at
  most 32 skills (`PUT …/offer` → 409 `offer_limit`, under a team advisory lock). Tests: resolver
  unit (65 → 64 + omissions, exactly 64), DB (32 named + 33 offered → start with 64, one omission;
  33rd offer refused, room after turning one off), web (refusal shown).
- M1: usage is windowed to 90 days and reads the partial index `runs_skill_uses_idx (team_id,
created_at) WHERE jsonb_array_length(skills_used) > 0`, custom migration **0102** (IF NOT EXISTS;
  lock note in the SQL and docs/install.md). EXPLAIN as the app role under RLS (test
  "M1: the usage read uses runs_skill_uses_idx"): `Bitmap Index Scan on runs_skill_uses_idx`,
  `Index Cond: ((team_id = …) AND (created_at > (now() - '90 days'::interval)))`.
- L1: members who may not read a team agent's definition see only published, active agents by
  their published name, `via` offer or none; no draft, exclusivity or naming detail (DB test).
- L2: `runSkillRefs` pairs each bundle with the effective skill of the same name and hash; a
  shared directory (identical bytes) goes to the first listed skill only (unit test).
- Flaky test: the full server run once failed `workspace-sync-limits` "commits racing collection…"
  (30 s timeout; passes alone and on main). Per the review, `:150` now waits with
  `lockTimeoutMs: 2_000` (was 300 ms) so all six requests arrive while the first still waits.

## Open questions

- Personal skill usage is per team (runs are team rows). `skill_refs` stays on ended runs
  (≤ ~7 KB); clearing it at run end is a possible follow-up (review I2).

## Evidence

- ac-1: `services/server/src/skills/detect.test.ts` (forged/workspace/relative/traversal paths),
  `services/server/src/skill-use.db.test.ts` (end to end through the wire, earlier-batch call,
  markers after reload, usage visibility), `apps/web/components/chat/skill-badge.test.tsx`.
- ac-2: `services/server/src/resolver/resolve.test.ts` (offer cases), `skill-use.db.test.ts`
  (approved only, blocklist, exclusive, another team never, scheduled trigger, admin-only switch,
  reach, cross-team 404), `apps/web/components/admin/skill-reach.test.tsx`.
- ac-3: `apps/web/components/chat/agent-picker.test.tsx` ("KOBE-297: shows each agent's origin").
