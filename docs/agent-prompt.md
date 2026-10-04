# Ticket agent handoff

How the coordinator hands a ticket to an agent while keeping token use low. Rules for the agent
itself are in [parallel-work.md](parallel-work.md).

## Coordinator steps

```bash
scripts/hadron.sh ignite                 # compact briefing (add --full for project notes)
scripts/hadron.sh next                   # or pick from "Ready now"
scripts/hadron.sh start <N>              # backlog -> ready if needed, claim
git worktree add ../Kobe-wt<N> -b kobe-<N>-<slug> origin/main
cp CLAUDE.local.md ../Kobe-wt<N>/
scripts/hadron.sh brief <N> > ../Kobe-wt<N>/BRIEF.md   # untracked; the agent reads only this
```

Before starting a ticket, check the other open tickets: don't run two tickets at once that both add
migrations or touch the same area (`tenancy/<area>.ts`, a route module, `packages/protocol`),
unless one is meant to wait for the other. Rebase and conflict rounds cost a full re-run of the
tests and review.

## Model per job

| Job                                                                    | Model  |
| ---------------------------------------------------------------------- | ------ |
| Coordinator; review of auth, RLS/migrations, sandbox isolation, policy | Opus   |
| Ticket implementation                                                  | Sonnet |
| CI watching, rebase/merge chores, ledger and Hadron bookkeeping        | Haiku  |

Use Opus for a ticket agent only when the ticket is mostly a security or isolation design problem
(for example KOBE-71).

## Prompt template

Fill the angle brackets; keep the prompt to the brief plus these lines. Don't paste spec text or
other ledgers into it — `BRIEF.md` already holds what the ticket needs.

```text
Implement <KOBE-N> in ../Kobe-wt<N> (branch kobe-<N>-<slug>). Work only there.
Read BRIEF.md first (ticket, criteria, spec, decisions), then CLAUDE.md and docs/parallel-work.md.
Read other code and ledgers only as needed; prefer grep over reading whole files.

<Anything the brief lacks: dependencies that just merged, a binding decision, files to start from.>

Rules: tests first; notes in docs/ledger/KOBE-<N>.md (template; stay under ~150 lines, link
evidence instead of pasting logs). Before pushing run `pnpm verify`. Open a PR, then wait for CI
with one background `gh pr checks <n> --watch` (no polling loops); fix failures. Don't merge, don't
touch Hadron.

No interim status messages: report once, when CI has finished.
Final report, at most 150 words: PR number, CI status, criteria met (ac-1 ...), open questions.
```

## Review, sized by risk

| Diff touches                                                                | Review                                   |
| --------------------------------------------------------------------------- | ---------------------------------------- |
| `packages/db`, migrations, auth, approvals/HMAC, sandbox, isolation, egress | Opus: one security + DB pass on the diff |
| Other service or web code                                                   | `/code-review medium` on the PR          |
| Docs, CI config, chart values only                                          | Coordinator reads the diff               |

One review pass per PR with a combined checklist; send findings back to the same agent
(`SendMessage`) rather than starting a new one, so it keeps its context.

## After merge

```bash
scripts/hadron.sh close <N> <pr>         # complete -> done (refuses gate tickets KOBE-1..4)
scripts/hadron.sh cost <N> <in> <out> <dollars> <model>
git worktree remove ../Kobe-wt<N>
```

Start a fresh coordinator session per wave; `docs/RUN-LEDGER.md` is the handoff.
