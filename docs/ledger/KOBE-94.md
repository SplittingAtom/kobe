# KOBE-94: Orbit scores in inventory, version history and gallery (52c)

- **Status:** in review (PR in the final report)
- **Branch / worktree:** `kobe-94-orbit-scores` in `../Kobe-wt94`
- **Depends on:** KOBE-93 (`orbit_evals`), KOBE-86 (inventory), KOBE-84 (builder), KOBE-87/89 (gallery)
- **Migrations:** `0063_gallery_agent_scores` (generated: table), `0064_orbit_evals_scope_gallery` (custom: scope
  CHECK re-added NOT VALID, then VALIDATE).

## What it does

- **Inventory** (`GET /v1/agents/inventory`): `orbitScore {status, attackSuccessRate, at}` per agent, from the
  same grouped query (two more CTEs, no per-row queries): team and personal agents use this team's newest
  `orbit_evals` row (`DISTINCT ON (agent_id)`, `team_id` explicit, `agent_id IN page`); gallery agents use
  the install-level score of their current version. Status: none, evaluating (pending/running), passed,
  blocked, errored. The web column shows "12% (passed)" and the date.
- **Version history:** each version's score (already in `GET /versions`) now links to a report page
  `/admin/team/agents/[id]/evals/[evalId]` (`eval-report.tsx`, uses `GET /v1/agents/:id/evals/:evalId`).
  The report is untrusted JSON from the Job: read defensively and rendered as React text only, no HTML.
- **Gallery scores:** see below. Cards (team gallery, install gallery) show the ASR, status, version, date.

## Decisions

- **`orbit_evals` cannot hold install scope cleanly:** `team_id NOT NULL` + FORCE RLS, and the Job, namespace,
  gateway token and budget all belong to a team. So a gallery eval is **run in a host team** (an
  `orbit_evals` row with scope `gallery` is the execution record; migration relaxes the scope check) and its
  verdict is **copied** to the install-wide, append-only `gallery_agent_scores` (agent, version, status,
  ASR, attempts, threshold, report, `evaluated_at`; FK to `install_agent_versions`). No team id in it.
- **Install admin action** `POST /v1/install/gallery/agents/:id/eval {teamId}` (`install.gallery.manage`): 202. `teamId` must be a team the caller belongs to (the gateway checks membership and the team's budget
  pays); not a member or unknown team: one 404 (no probing). Needs a published version, and a model the
  host team can use (agent's pin or team default), else 409. One eval per (team, agent) at a time.
  The gallery stays read-only otherwise (the 405 catch-all is unchanged).
- Threshold = install default `DEFAULT_EVAL_MAX_ASR` (20 %); the status is relative to it.
- `EvalRunner.conclude` for scope `gallery`: passed/blocked write the score and **publish nothing**;
  the score is inserted in `finishEval`'s transaction (a failed insert rolls the verdict back; tested);
  errored stores no score (the host team's eval row keeps the error). The version scored is kept in
  `orbit_evals.definition.galleryVersion` (the `version` column is reserved for published passes).
- **Scores are per version:** reads join on `install_agents.current_version`, so after a release changes
  an agent its card says "Not evaluated" until re-run (old scores stay in the table).
- **Read APIs:** `GET /v1/agents/gallery-scores` (any team member) and `GET /v1/install/gallery/agents/scores`:
  one query (`DISTINCT ON`), same shape. Cards degrade to "—" if scores fail to load.
- Audit: the host team's `agent.eval.requested` / `agent.eval.finished` cover it; no new action.

## Open questions (for Chris or the coordinator)

- Evals are manual (admin button). Running them at seed time needs a host team at startup (none exists
  then), so a seed-time job was not built; a scheduled "re-evaluate stale gallery versions" would be a follow-up.
- A gallery eval spends the host team's model budget and sandbox capacity. Acceptable, or should the
  install own a dedicated "gallery" team?
- A personal agent's score shows only in the team it was published in (inherited from KOBE-93).

## Evidence

- ac-1 (inventory latest score): `agent-inventory.db.test.ts` (shape), `gallery-scores.db.test.ts`
  "inventory scores" (none, errored, evaluating, blocked, passed, no cross-team leak, gallery);
  `team-pages.test.tsx` "shows each agent's latest score and status".
- ac-2 (gallery published scores): `gallery-scores.db.test.ts` "gallery scores (install level)" (run, score,
  blocked, errored, version change, authz); `team-pages.test.tsx` and `install-pages.test.tsx` (cards, run eval).
- Version history link and report rendering (escaped text): `agent-builder-pages.test.tsx`.
- `pnpm verify`, server and `@kobe/db` `test:db` (probe): see PR.
