# The Kobe Explorer Gate: MCP Apps (KOBE-441)

Evidence harness for the MCP Apps host (`docs/specs/mcp-apps-host.md` §11, Catalyst spec
`0612ef17` §8): _an MCP App works in the conversation first, then from the rail, with the
negative checks, on k3d in CI and on the gate install against Catalyst's Lakehouse Explorer._ It
closes KOBE-432 ac-2 together with Catalyst M24. The harness changes no product code; a failing
check stays and is filed.

Two runs, both required:

- **(a) k3d, in CI** (`e2e/gate-apps.sh`, shard `gate-apps`): the fake MCP server
  (`e2e/lib/fake-mcp.js` with `FAKE_MCP_APPS=1`) serves `ui://e2e/explorer`, a small test app
  speaking the ext-apps protocol; the scripted model calls its opening tool when told
  `tool: mcp__e2e_apps__open_explorer <json>` and echoes what it was given (`history?`).
- **(b) the gate install** against Catalyst, a real model and Pi: the coordinator's run
  (`docs/gates/gate-apps-runbook.md`), with the same browser spec.

## Running it

```bash
# CI: after the gate1-prep install, with the browser checks in Chromium
KOBE_E2E_SHARD=gate1-prep KOBE_IMAGE_TAG=<tag> e2e/run.sh && KOBE_GATEAPPS_BROWSER=1 e2e/gate-apps.sh

# API checks only; then judge a Playwright report made elsewhere
KOBE_GATEAPPS_BROWSER=0 e2e/gate-apps.sh
KOBE_GATEAPPS_RESULTS=<results.json> e2e/gate-apps.sh
```

**What it creates (k3d).** Namespace `kobe-gate-apps-infra` with the `fake-mcp` pod and Service;
a chart upgrade that lets the MCP proxy reach exactly that Service over plain HTTP (saved values
plus `--reset-values`); site connectors `e2e-apps` (no auth) and `e2e-apps-key` (each member's own
API key) with their tools and template pinned and approved; team `gate-apps-a` with
`gate-apps-ad@gate-apps.test` (team admin, the browser's member, who has a key for
`e2e-apps-key`) and `gate-apps-m2@gate-apps.test` (a member without one); their threads.

## What each check proves

The script prints one section per part; the verdict line is `Kobe Explorer Gate (k3d): proven`, or
`Kobe Explorer Gate: FAILED (…)` with the parts that failed. CI's `stories` job requires it
(`e2e/gate-verdicts.sh`).

### In the conversation (spec §11 a, 1–8)

| §11 | Check                                                                                                                                                                                                                                                                                                                                                                                                                 | Where                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | The connector registers and pins its tools and `ui://e2e/explorer`; the template is approved; the team enables it; the member has the app (MA8).                                                                                                                                                                                                                                                                      | API `setup`                                |
| 2   | **Real Pi passes MCP arguments unchanged.** The model calls the opening tool with `{"depth":"5"}` (a string for an integer) and with `{}` (a schema default): each tool card gets the app, so the server's claim digested Pi's `tool.call` input equal to the input the proxy captured (a mismatch would fail safe as text). The script prints what Pi recorded (`pi_input`) and what the upstream received (`CALL`). | API `args`; browser test 1 (`app-results`) |
| 2   | The tool card renders the app (its tree).                                                                                                                                                                                                                                                                                                                                                                             | browser test 1                             |
| 3   | Expanding a node makes exactly one app call, through `/v1/team/apps/…/calls`, audited `mcp.app_call` with the member's id; a write tool is refused and audited.                                                                                                                                                                                                                                                       | browser test 1; API `bridge`               |
| 4   | Selecting a table shows the context chip.                                                                                                                                                                                                                                                                                                                                                                             | browser test 1                             |
| 5   | "Use in chat" inserts `` Use table `c.n.t` `` into the composer with the "From" marker, and no message is sent.                                                                                                                                                                                                                                                                                                       | browser test 1                             |
| 6   | After Confirm and Enter, the message carries `app_context`; the run's input holds the fenced `<app-context source="connector:e2e-apps" untrusted="true">` block; the answer streams.                                                                                                                                                                                                                                  | browser test 1                             |
| 7   | A reload rebuilds the app with no app call (the stored result, never the upstream).                                                                                                                                                                                                                                                                                                                                   | browser test 1                             |
| 8   | Expand moves the app into the artifact column ("Opened in the side column"); closing the tab brings it back.                                                                                                                                                                                                                                                                                                          | browser test 1                             |
| —   | **Frame isolation (KOBE-437 ac-1)**: from the frame, fetch, XHR, WebSocket, a remote image, a form post, `window.open`, top navigation, cookies, storage and the parent DOM all fail; the header CSP alone isolates it. `KOBE_REQUIRE_APP=1`: no app is a failure.                                                                                                                                                    | `app-frame.spec.ts`                        |

### From the rail (spec §11 a, 9–10)

| §11 | Check                                                                                                                                                                                               | Where                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 9   | A launch from the new-thread view starts a thread with the app card and **no run**; the next run's model was given the card fenced, untrusted, opened by the member, without the structured result. | API `rail`; browser test 3  |
| 10  | A launch during a run is queued (a chip, "App: … (waits for the run)") and goes in when the run ends, once, before the next message.                                                                | API `queue`; browser test 4 |

### Negative checks (spec §11)

| Check                                                                                                                     | Where                           |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| The app's `fetch` out, `ui/open-link` and its call to the write tool fail (the test app's probes).                        | browser test 2                  |
| A forged result report is refused at the server's internal listener (no internal key: 401; a forged sandbox token: 401).  | API `forged`                    |
| A changed template drifts: the refresh reports it, the rail drops the app, the earlier card is text (`template_changed`). | API `drift` (after the browser) |
| A member without a key has no rail app, sees "Add your key", and sees a shared thread's card as text (`no_access`).       | API `nokey`                     |
| No credential (the member's key) is in any Kobe answer the browser received, frame documents included.                    | browser test 5                  |
| An export of the thread carries the card's text, never the structured result or the template.                             | API `export`                    |

## Evidence

Record each run here: the CI run (its `gate-log-gate-apps` artifact) and, for the gate install,
the runbook's screenshots, audit rows and the thread's entries.

| Run                       | Date | Result      | Evidence |
| ------------------------- | ---- | ----------- | -------- |
| k3d (CI, shard gate-apps) |      | not run yet |          |
| Gate install (Catalyst)   |      | not run yet |          |

## Notes

- The k3d spec and the gate install share one spec (`e2e/browser/tests/gate-apps/explorer.spec.ts`):
  the app, its tree path, the "Use in chat" text and the prompt come from `KOBE_APPS_*` variables
  (`e2e/browser/README.md`).
- If check 2 fails (the card is text), Pi altered the arguments: compare `pi_input` with the
  upstream's `CALL` line. The product fails safe (text); the gate reports it as a finding.
- Firefox's WebRTC behaviour (spec §3, residual risk) is measured with `KOBE_ALL_BROWSERS=1` in the
  Playwright container at the gate install.
