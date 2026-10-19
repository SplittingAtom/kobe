# KOBE-427: the thread read never reported the pinned agent's model (agent_model), so the chat offered Regenerate with on a pinned-model agent

- **Status:** in progress (group G5, branch `group-5-gates`)
- **Branch / worktree:** `group-5-gates` in `../Kobe-g5`
- **Depends on:** found by KOBE-227's Gate 5 U22 browser check (gate5-b, CI run 39145480035)

## Plan

Implement the KOBE-44 `pinnedModel` seam in the production run resolver (`PINNED_AGENTS`,
`services/server/src/runs/agents.ts`): the pinned version's frontmatter `model`, read from
Postgres only. `GET /v1/threads/:id` then reports `agent_model`, and the chat locks its picker and
hides "Regenerate with…" (it already did when `agent_model` was set).

## Decisions

- The seam existed with a test resolver only (`thread-model.db.test.ts`); production returned
  undefined, so `agent_model` was always null. Auto-titles (title-source) use the same seam and now
  title with the agent's model, as they were written to.
- An unavailable pinned version pins nothing in the read; its run fails `agent_unavailable` anyway.

## Product failures found

None.

## Evidence (acceptance criteria → test or command output)

- `services/server/src/agent-versions.db.test.ts` "reports the model the pinned version pins":
  failed before (agent_model null), passes after; thread-model, threads, thread-title,
  runs-model, runs-resolver db suites pass (dev Postgres).
- Commit "fix(server): a thread read reports the model its pinned agent version pins" (made before
  the ticket had its id; it names KOBE-227).
- Gate 5 U22 "Regenerate with is hidden for an agent that pins its model": pending CI round 2.
