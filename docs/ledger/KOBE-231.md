# KOBE-231: G3a: e2e/gate3.sh — Phase 3 product gate, all five criteria end to end

- **Status:** in progress (group G5, branch `group-5-gates`; not pushed)
- **Branch / worktree:** `group-5-gates` in `../Kobe-g5`
- **Depends on:** none open (KOBE-156..158, 162..164, 152 are merged; their checks run green-or-filed)

## Plan

`e2e/gate3.sh` modelled on gate2.sh: own team `gate3-a` (admin, Builder, two members), one step per
criterion, ok/FAIL lines. Client steps run in a server pod (`e2e/gate3/client.mjs`, appended to the
Gate 1 and Gate 2 clients' helpers). Browser checks in Chromium beside kubectl
(`e2e/browser/scripts/gate3-browser.mjs`). Docs: `docs/gates/gate-3.md`. CI: shard `gate3`.

## Decisions

- **No pending checks.** Every wave D ticket the brief named (memory 156..158, projects 162..164,
  share_file 152) is merged, so every check runs against the product, none is marked pending.
- **CSP is a response header, not a `srcdoc` meta tag.** The brief asks to assert a CSP `<meta>` in
  the artifact's `srcdoc`. The product never uses `srcdoc`: the chat embeds
  `/v1/artifacts/:id/versions/:n/frame`, which sends the CSP as a header (with `sandbox`, which a
  meta tag cannot set). The checks assert the header and, in Chromium, that the frame's `fetch` is
  blocked by a `connect-src` violation with no request leaving the page. Same criterion (U3 "under
  a strict CSP"), stronger mechanism; not a product failure. Accepted by the coordinator
  (2026-10-18), recorded in docs/gates/gate-3.md; on Chris's gate-review list as a wording difference.
- **Data Analyst → Kobe.** KOBE-254 retired the Data Analyst gallery agent; its skills
  (data-analysis, charts) belong to the gallery agent Kobe, which ac-5 uses.
- **Two losses for U15.** `deleted` (pod + PVC deleted while running, the brief's wording) and
  `overnight` (hibernated, then the volume deleted: U15's "next turn shows waking"). `waking` is
  asserted only for the overnight case: a deleted pod is recreated by the controller and may be
  running before the next turn.
- **JSONL rebuild evidence.** No audit event exists for a session rebuild; the checks use the
  session file in the new sandbox, the server's `Pi session lost; restoring from Postgres` log line
  for the thread, and (scripted model) `history?` echoing the earlier turns.
- **Skill loading evidence** is the run's `run.start` frame in `sandbox_commands` (the list Pi is
  launched with), `context.omitted`, and (scripted model) Pi's system prompt via `system?`.
- **Expected failures** (`xcontains` in `e2e/lib/gate-common.sh`): XFAIL keeps CI green while a
  filed product failure is open; XPASS fails once it passes; `KOBE_GATE_STRICT=1` for sign-off.
- **Sign-ins from varying addresses** (198.51.102.x): every step signs in, and sign-in is limited
  to 3 per 10 s per address.
- Shared helpers: `e2e/gate1/client.mjs` `call()` takes extra headers (If-Match) and `raw()` sends
  zips and FormData; `e2e/gate2/sandbox.sh` messages name the user (`SBX_WHO`).

## Product failures found

1. **KOBE-420, ac-1 (U8): the chat has no "v<N> available" badge and no one-click switch.** The API has both
   (`GET /v1/threads/:id` → `agent_version`, `agent_current_version`; `POST
/v1/threads/:id/agent-version`), but `apps/web/lib/chat/thread-controller.ts` drops
   `agentCurrentVersion` (`agentCurrentVersion: _v`) and no component renders a badge or switch
   (none since KOBE-46). Check: `ac-1 browser: the pinned thread shows 'v3 available'` and
   `...with a one-click switch`, marked expected-fail in `e2e/gate3.sh`. Fix: render the badge
   with a switch in the thread header when `agent_current_version > agent_version`. Filed as
   KOBE-420 (G5 lane, after KOBE-227); the XFAIL marks flip when it lands.

## Open questions (for Chris or the coordinator)

- Real-cluster run needs a quiet gate1 and the go-ahead: it creates team `gate3-a` there and
  deletes gate3-m1's sandbox volume twice.

## Evidence (acceptance criteria → test or command output)

- ac-1 (five criteria on k3d in CI, shard `gate3`): pending the group CI run.
- ac-2 (targets an existing install with a real model, evidence per criterion): `KOBE_GATE3_*`
  (docs/gates/gate-3.md "Running it"); not run on the cluster yet (needs the go-ahead).
- ac-3 (each check tied to its criterion, nothing weakened): check names carry `ac-N`; the one
  product failure is filed above and its check stays (XFAIL).
- Local: `bash -n`, shellcheck (warning level) clean; actionlint clean; the browser script run
  against a local page with and without the CSP header (blocked vs allowed, 0 vs 1 beacon hits);
  the test skill zip accepted by the server's `validateZipBundle` and flagged `network/curl-wget`.
