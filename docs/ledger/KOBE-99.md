# KOBE-99: Omission notice for unapproved skills

- **Status:** PR A in progress (protocol + web fallback); PR B (resolver) stacked on A
- **Branch / worktree:** `kobe-99-unapproved-skill-notice` in `../Kobe-wt99`
- **Depends on:** KOBE-80 (merged)

## Plan

- PR A: add `not_approved` to the `context.omitted` reason enum (additive), README, protocol tests.
- PR B: emit it from the server when a skill is dropped for lacking approval.

## Decisions

- The web notice indexed `REASON_TEXT[reason]` and would print "undefined" for an unknown reason.
  PR A adds a generic fallback sentence ("it was left out of this run") and the `not_approved`
  text (the `Record` type forces it once the enum grows), with tests for both.
- Old clients that validate the payload with the previous zod enum would reject the event; this is
  the same additive-enum risk as every earlier reason and is accepted (server and web deploy
  together via the chart).

## Open questions

## Evidence

- ac-2: PR A touches protocol, its README and the web notice only; no migrations.

## PR B (resolver, stacked on PR A's branch)

- Resolver stays pure: `agent.unapprovedSkills` / `user.unapprovedSkills` (names) are new optional
  inputs; `loadSkillFacts` computes them (agent names minus approved ones; personal blocked set from
  the new `personalSkillUsage`, which `usablePersonalSkills` wraps).
- An agent skill name with no team skill at all also gets `not_approved` (it lacks an approved
  version either way).
- Personal blocked skills get `agent_exclusive` / `team_disabled` when those apply (existing
  precedence), else `not_approved`. Per-team: blocked state is read per team's review rows.
- Evidence: `resolve.test.ts` (unit), `runs-resolver.db.test.ts` (ac-1 end to end, flagged personal).
