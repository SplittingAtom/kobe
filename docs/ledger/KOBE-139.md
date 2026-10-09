# KOBE-139: Dev hygiene: self-fixing verify, generated snapshots, agent prompt rules

- **Status:** in review
- **Branch / worktree:** `kobe-139-dev-hygiene` in `../Kobe-wt139`
- **Depends on:** none. Companion CI tickets: KOBE-134 (Traefik DNS flake), KOBE-135 (egress 504
  flake), KOBE-138 (build images once).

## Why

CI analysis on 2026-10-09 (300 runs, Oct 5–8): of 18 red `ci`/`e2e` runs, 2 were `prettier
--check` failures from agents that skipped `pnpm verify`, and migration PRs carried 10k–30k lines
of `drizzle/meta/*_snapshot.json` that reviewers and agents read (PR #112: 33,747 lines, ~30k of
them snapshots). Six zombie `until ! pgrep -f "gh pr checks"` loops from ticket agents were still
running 5–8 h after their PRs merged (`pgrep -f` matches the loop's own command line). No ticket
had cost data in Hadron.

## Decisions

- `pnpm verify` now runs `prettier --write` first (so the commit after it is formatted) and
  `test:db` when `KOBE_TEST_DATABASE_URL` is set. `format:check` stays for CI.
- `packages/db/drizzle/meta/*_snapshot.json` is `linguist-generated` (collapsed on GitHub). Not
  `-diff`: local `git diff` still shows it when someone wants it. The journal and `.sql` files stay
  reviewable.
- Prompt template: exactly one background `gh pr checks --watch`, never loops around pgrep/sleep;
  report token use for `hadron.sh cost`; skip snapshots when reading diffs; migrations land in
  their own small PR before the feature PR (lets a feature half proceed while the next migration
  is in flight).

- Found by the first `verify` run on this branch, under load (three agents building in parallel):
  `services/server/src/skills/bundle.test.ts` "aborts an entry that inflates far beyond its
  declared size" timed out at 5 s. It is CPU-bound (~1.1 s alone) and had already failed CI once
  (run 37376882020, 2026-10-05). Explicit 30 s timeout, like KOBE-133.

## Evidence

- ac-1: `pnpm verify` on this branch (formats, lint, typecheck, test, test:db, license, hygiene).
