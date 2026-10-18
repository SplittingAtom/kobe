# Gate 5: Conversation (v1.1), user stories U17–U24 (KOBE-227)

Evidence harness for the v1.1 gate (Conversational Enhancements spec, CE1): _U17–U24 pass end to
end on k3d (CI) and on the real cluster with a real model, with no regression in Gates 1–4._
`e2e/gate5.sh` gives one verdict per story. It changes no product code; a failing check stays and
is filed.

A story is proven by its **browser checks** (Playwright in Chromium, `e2e/browser`: the specs its
tickets added, plus `e2e/browser/tests/gate5/` for the criteria those leave out) and, where a
browser can't see it, **API checks** run in a server pod (`e2e/gate5/client.mjs`). A story passes
when every one of its tests passes and its API section has no `FAIL`. A test marked `test.fail()`
for a filed product failure prints `XFAIL` (CI stays green; the story is not proven) and `XPASS`
once it passes; a skipped test prints `NOTRUN` and the story is not proven there.
`KOBE_GATE_STRICT=1` turns expected failures into failures for a sign-off run.

## Running it

```bash
# CI: shards gate5-a (U17–U20) and gate5-b (U21–U24), each after the gate1-prep install:
KOBE_E2E_SHARD=gate1-prep KOBE_IMAGE_TAG=<tag> e2e/run.sh && KOBE_GATE5_BROWSER=1 e2e/gate5.sh

# the real cluster (not run yet): the API checks and fixtures where kubectl works ...
KUBECTL='sudo k3s kubectl' KOBE_GATE5_CONTEXT=<context name> KOBE_GATE5_NS=kobe-gate1 KOBE_GATE5_RELEASE=kobe \
KOBE_GATE5_MODEL=<the team's default alias> KOBE_GATE5_MODEL2=<a second alias> KOBE_GATE5_REASONING=1 \
KOBE_GATE5_OWNER_EMAIL=<the Owner> KOBE_GATE5_OWNER_PASSWORD=<the Owner's password> KOBE_GATE_STRICT=1 \
  e2e/gate5.sh
# ... prints the Playwright command (with the pinned thread it made) to run where Chromium reaches
# the site, e.g. the Playwright container; then judge its report:
KOBE_GATE5_RESULTS=<results.json> <the same variables> e2e/gate5.sh
```

| Variable                                 | Default                 | Meaning                                                                                     |
| ---------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `KOBE_GATE5_STORIES`                     | `U17` … `U24`           | The stories to check.                                                                       |
| `KOBE_GATE5_MODEL` / `_MODEL2`           | `fast` / `smart` on k3d | The team's default model and a second one (Regenerate with).                                |
| `KOBE_GATE5_BROWSER`                     | 1 in CI, else 0         | Run Playwright here (k3d: through a port-forward to Traefik, `KOBE_BROWSER_MAP`).           |
| `KOBE_GATE5_RESULTS`                     | none                    | A Playwright JSON report made elsewhere, to judge instead.                                  |
| `KOBE_GATE5_REASONING`                   | 0                       | 1: the real team default model reasons (U21's reasoning block).                             |
| `KOBE_GATE5_KILL_SANDBOX` (to the specs) | set by `e2e/gate5.sh`   | The command that deletes the member's sandbox pod mid-run (U19 interrupted); needs kubectl. |

**What it creates.** Users `gate5-ad@gate5.test` (team admin; the browser's member) and
`gate5-m2@gate5.test` (member; the second browser of U24) in team `gate5-a`; their threads (the
specs move theirs to Trash), workspace files (deleted again), a project (organize.spec), an agent
that pins the team's default model. With the fake model it adds the catalog entry `g5ctx` (the fake
provider, a 200,000-token window) as the team's default. The member's stored layout is put back
where the specs change it.

**The fake model (CI).** The scripted upstream (`services/model-gateway/src/testing/fake-llm.ts`)
echoes prompts, runs `bash: <command>` and `tool: <name> <json>`, reasons on `think?`, and since
KOBE-227 streams `kobe-long-answer=<n>` as n lines 60 ms apart (runs that last long enough to
scroll, queue, steer and stop) and reports `kobe-prompt-tokens=<n>` as the call's prompt size (the
context gauge). The specs choose the prompt by `KOBE_FAKE_MODEL` (`tests/support/gate5.ts`); a
real model gets plain instructions.

## The stories and their checks

| Story | Browser specs (`e2e/browser/tests/`)                                          | API checks (`==> Uxx api:`)                                       |
| ----- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| U17   | chat-layout, rail-header, rail-resize, gate5/u17-workspace                    | —                                                                 |
| U18   | scroll-follow, gate5/u18-never-lose                                           | —                                                                 |
| U19   | steering-panel, gate5/u19-steering                                            | —                                                                 |
| U20   | context-gauge, compact-now, gate5/u20-gauge                                   | usage read = newest `run_usage` row; window from the catalog      |
| U21   | gate5/u21-history                                                             | —                                                                 |
| U22   | root-edit, fork, regenerate-with, gate5/u22-fork-compare                      | an agent pinning its model, and a thread on it                    |
| U23   | auto-title, organize, command-palette, file-mentions, gate5/u23-organize-find | untitled thread titled after run 1; rename locks it through run 2 |
| U24   | share                                                                         | admin: 404 while private, read-only while shared; audit rows      |

What the `gate5/` specs add, per criterion:

- **U17** at 1280, 960, 800 and 390 px with an artifact open: rail 280 / 48 / 48 / drawer, the
  artifact column ≥ 360 px (wide, medium), a sheet over the conversation (overlay), the
  conversation ≥ 400 px in every multi-column band; the rail collapsed, the Threads/Files divider
  and the artifact width set in one browser are stored (`/v1/me/preferences`) and applied in a
  second browser that signs in on its own.
- **U18** an artifact and a workspace file open as tabs beside the thread with the composer and the
  answer on screen; My memory and My approvals beside the thread (`?area=`), Back returning to
  each in turn;
  scrolled up, two messages sent from another tab make the pill say "2 new messages" while the
  view holds; the composer in view and no page scroll at 1920, 1280, 960, 800 and 390 px.
- **U19** one run of the panel through idle (zero height), active, queued (paused queue after
  Stop), a queued message edited and run as edited, Steer now reaching the running agent, waiting
  (an approval); interrupted by deleting the sandbox pod mid-run, then Retry, and again, Continue.
- **U20** with the fake: 120k, 140k and 172k of 200k tokens read `ok`, `warn`, `full`, and red offers
  Compact now; with a real model the level matches the 65/85 rule for whatever the turn used.
- **U21** after a reload: the reasoning block, a tool card that opens to its output, the hover
  footer ("Answer details") and the thread's model, approval and stopped markers; a tool output
  over 64 KB read in full when its card opens (skipped, `NOTRUN`, when the tool trimmed its output
  below 64 KB first); Mod+Shift+D opens every block, is stored, and a second browser opens with it.
- **U22** fork markers ("2 branches") at the edited first message and at a regenerated answer; the
  fork's "Forked from" link opens the source; Regenerate with another model switches the picker;
  on the pinned agent's thread Regenerate is offered and Regenerate with is not.
- **U23** a rename in the header survives two later runs (and the API check proves the lock); the
  palette lists a workspace file by name and opens it as a tab.

## Product failures found

1. **U18: memory and the member's settings pages left the conversation** (CE4). Fixed by KOBE-424
   on this branch: My memory, My approvals, My schedules and My connectors open beside the thread
   in the chat; the check is an ordinary test again.

## What this does not prove

- Touch gestures and real phones: the narrow checks are Chromium at 390 px.
- U21's 64 KB path when Pi's own tools trim output first (it then reports `NOTRUN`).
- U20's thresholds with a real model (only that the level matches the reading).

## Verdict

_Filled in from the CI run and the real-cluster run._
