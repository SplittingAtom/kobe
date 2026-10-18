# KOBE-227: Gate 5 — Conversation (v1.1): U17–U24 on k3d and on the real cluster

- **Status:** in progress (group G5, branch `group-5-gates`; not pushed)
- **Branch / worktree:** `group-5-gates` in `../Kobe-g5`
- **Depends on:** KOBE-204, KOBE-218, KOBE-226 (merged); the gate harness of KOBE-231/232

## Plan

`e2e/gate5.sh`: fixtures (team `gate5-a`, a team admin as the browser's member, a second member),
API checks in a server pod (`e2e/gate5/client.mjs`), the browser suite (`e2e/browser`) per story
plus `e2e/browser/tests/gate5/` for criteria the ticket specs leave out, and one verdict per story
from Playwright's JSON report (`e2e/gate5/verdict.mjs`). CI: shards `gate5-a` (U17–U20) and
`gate5-b` (U21–U24) after the gate1-prep install. Docs: docs/gates/gate-5.md.

## Decisions

- **Reuse the browser suite as the gate's evidence.** The ticket specs (chat-layout, steering,
  share, ...) already prove most criteria; each story names its specs (`SPECS` in `e2e/gate5.sh`)
  and `tests/gate5/` adds the rest, one test per criterion group, titled by story.
- **Fake model in CI.** The suite was written for real models; `KOBE_FAKE_MODEL=1` swaps in the
  scripted model's grammar (`tests/support/gate5.ts`). Two markers were added to the fake upstream
  (test code, with unit tests): `kobe-long-answer=<n>` (a slow stream: scroll, queue, steer, stop)
  and `kobe-prompt-tokens=<n>` (the gauge's fill). scroll-follow, steering-panel, chat-layout and
  file-mentions now pick their prompts by it; nothing else in them changed.
- **U20 thresholds** with the fake: catalog entry `g5ctx` (200,000-token window) as the team
  default; 120k/140k/172k read ok/warn/full. Real model: the level must match the 65/85 rule.
- **U19 interrupted** needs the sandbox lost mid-run: the spec runs `KOBE_GATE5_KILL_SANDBOX` (set by
  gate5.sh beside kubectl); without it the test is `NOTRUN`.
- **Expected failures** in Playwright are `test.fail()` (off under `KOBE_GATE_STRICT=1`); the
  verdict maps them to `XFAIL`/`XPASS` like the bash gates.
- **Real cluster:** API checks where kubectl works; the browser part runs where Chromium reaches the
  site (the printed command), and `KOBE_GATE5_RESULTS=<report>` judges it.
- Two shards, not one, to stay near 20 minutes each on hosted runners (unmeasured).

## Product failures found

1. **U18 (CE4): memory and the member's settings leave the conversation.** The bar's My memory and
   the profile menu's pages (My approvals and the rest) are full-page routes
   (`apps/web/components/shell/bar-links.tsx`: "full pages for now; CE4 moves some beside"), so
   the thread leaves the screen. Check `U18: memory and the member's settings open beside the
thread (CE4)`, `test.fail()` (CI green, story XFAIL).

## Open questions (for Chris or the coordinator)

- U21's "over 64 KB on expand": Pi's own bash tool seems to trim its output (about 50 KB) before
  the chat's 64 KB limit, so no tool in the install may reach it; the check then reports `NOTRUN`
  and U21 is not proven. If CI shows that, U21 needs a tool that returns more (an MCP fixture) or a
  ruling that the component tests cover it.
- Real-cluster run (ac-2) needs the go-ahead, a reasoning team default model and a second model.
- ac-3 (no regression in Gates 1–4): the same group CI runs shards gate1–gate4 and `stories`.

## Evidence (acceptance criteria → test or command output)

- ac-1 (U17–U24 on k3d): shards `gate5-a`, `gate5-b`; pending the group CI run.
- ac-2: command in docs/gates/gate-5.md; not run.
- ac-3: the group CI's gate1–gate4 shards and the `stories` job.
- Local: `bash -n`, shellcheck clean; actionlint clean; `tsc -p e2e/browser` and eslint clean for the
  specs; `node --check` on the composed client; the verdict script on a synthetic report (ok, XFAIL,
  FAIL, NOTRUN, missing file); `@kobe/model-gateway` tests 176/176 with the new fake-model tests
  (written first, red, then green).
