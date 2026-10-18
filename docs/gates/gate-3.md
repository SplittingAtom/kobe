# Gate 3: Product verification (KOBE-3)

Evidence harness for the Phase 3 gate (umbrella spec, KOBE-3: _U3, U8 without Orbit, U9, U10 and
U15 complete_). Each criterion must hold on k3d (CI) and on the real cluster. `e2e/gate3.sh`
(KOBE-231) runs all five against an installed Kobe and prints one `ok` / `FAIL` line per check with
its evidence; the browser checks run in a real Chromium (`e2e/browser/scripts/gate3-browser.mjs`).
It changes no product code. Where a check fails, the check stays and the failure is filed; nothing
here is weakened to pass. A check of a filed failure prints `XFAIL` (see
[Expected failures](#expected-failures)).

## Running it

```bash
# k3d (CI shard `gate3`): the install and model setup first, then the suite with the browser checks
KOBE_E2E_SHARD=gate1-prep KOBE_IMAGE_TAG=<tag> e2e/run.sh && KOBE_GATE3_BROWSER=1 e2e/gate3.sh

# the real cluster's install (run where kubectl reaches it), with a real model
KUBECTL='sudo k3s kubectl' KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
KOBE_GATE3_CONTEXT=<context name> KOBE_GATE3_NS=kobe-gate1 KOBE_GATE3_RELEASE=kobe \
KOBE_GATE3_OWNER_EMAIL=<the Owner> KOBE_GATE3_OWNER_PASSWORD=<the Owner's password> \
KOBE_GATE3_MODEL=<catalog alias enabled on the install> KOBE_GATE_STRICT=1 \
  e2e/gate3.sh
```

Without a browser where it runs, the script prints the exact `gate3-browser.mjs` command (thread and
artifact ids filled in) to run from a machine with Node and Chromium that reaches the public URL:

```bash
cd e2e/browser && npm ci && npx playwright install chromium
KOBE_BROWSER_BASE=<public URL> KOBE_BROWSER_EMAIL=gate3-m1@gate3.test KOBE_BROWSER_TEAM=<team id> \
KOBE_BROWSER_ARTIFACT=<artifact id>:1 KOBE_BROWSER_MEMORY_THREAD=<id> KOBE_BROWSER_PINNED_THREAD=<id> \
KOBE_BROWSER_PASSWORD=<the fixtures' password> node scripts/gate3-browser.mjs
```

| Variable                               | Default               | Meaning                                                                                                |
| -------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| `KOBE_GATE3_NS` / `KOBE_GATE3_RELEASE` | `kobe-dev` / `kobe`   | Release namespace and name.                                                                            |
| `KOBE_GATE3_CONTEXT`                   | none                  | Required for anything but a `k3d-*` kube context (the script reads the database as the app role).      |
| `KOBE_GATE3_STEPS`                     | all five              | Subset of `versions skills projects memory data`.                                                      |
| `KOBE_GATE3_MODEL`                     | `fast`                | Catalog alias the team uses. `fast` is CI's scripted model.                                            |
| `KOBE_GATE3_FAKE`                      | 1 for `fast`, else 0  | 1: prompts use the scripted model's grammar (`bash:`, `tool:`, `system?`, `history?`). 0: plain words. |
| `KOBE_GATE3_BROWSER`                   | 1 in CI, else 0       | Run the Chromium checks here (needs `npm ci` and `npx playwright install chromium` in `e2e/browser`).  |
| `KOBE_GATE3_BROWSER_MAP`               | a port-forward on k3d | `host:port` the browser connects to for the public host; empty on a real cluster (it resolves itself). |
| `KOBE_GATE3_OWNER_EMAIL` / `_PASSWORD` | CI owner              | The install Owner (first-run setup runs only on a fresh install).                                      |
| `KOBE_GATE3_SANDBOX_WAIT`              | `180`                 | Seconds m1's sandbox pod may take to be Running and Ready before the steps that need it are skipped.   |
| `KOBE_GATE_STRICT`                     | 0                     | 1: an expected failure is an ordinary `FAIL` (use it for a sign-off run).                              |

**Real models.** With `KOBE_GATE3_FAKE=0` every prompt is a plain instruction ("Use your bash tool
to run exactly this command ...", "Call the remember tool exactly once with exactly these
arguments ..."), and the checks read side effects (the run's events, the API, the database, the
sandbox) rather than the model's words. Checks that need the scripted model's echoes (`system?`
for the skill list, `history?` for the rebuilt conversation) run only with `KOBE_GATE3_FAKE=1`; the
agent-version checks then ask the model for the codeword in its prompt instead.

**What it creates.** Users `gate3-{ad,bd,m1,m2}@gate3.test` (team admin, Builder, two members),
team `gate3-a` (namespace `kobe-team-gate3-a`, m1's sandbox), and per run (named with a nonce): two
team agents with their versions, a team skill (`g3net-<nonce>`), a project with one file, memory
docs, threads and their artifacts and files. Re-running reuses the users and the team.

**What it changes.** The team's memory switches are turned on. One site blocklist entry for the
run's own skill bundle (removed on exit). ac-5 deletes m1's sandbox pod and its workspace volume
twice (the server makes new ones). Nothing else on the install is touched; on a real cluster, run
it on an install whose users can live with a `gate3-a` team.

## Verdict

_Filled in from the CI run and the real-cluster run; see the end of this file._

## ac-1 Agent versions: v1 threads stay pinned (U8 without Orbit, KOBE-46)

**Scenario.** The Builder (role `builder`) creates a team agent whose prompt carries a codeword
(`G3V1-<nonce>`) and publishes v1. m1 starts a thread on it. The Builder publishes v2 (codeword
`G3V2-…`); m1's thread keeps running v1; a new thread gets v2; one call switches the old thread;
rolling back to v1 publishes v3 with v1's definition.

| Check                                                                     | What it proves                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `thread_agent_version=1`, `started_agent=<agent>:1`, codeword `G3V1`      | A thread pins the version it started on; the run used that prompt. |
| after v2: `agent_pin=1:2`                                                 | The thread still names v1 and reports v2 as current (badge data).  |
| next turn on the v1 thread: `started_agent=<agent>:1`, `G3V1`, not `G3V2` | Publishing v2 does not move a v1 thread.                           |
| new thread: version 2, `G3V2`                                             | New threads get the current version.                               |
| `switch=200:2`, then `started_agent=<agent>:2`, `G3V2`                    | One call (`POST /v1/threads/:id/agent-version`) switches the pin.  |
| rollback: `version=3`, `republished_from=1`, v1's prompt; `1:-,2:-,3:1`   | Rollback republishes v1 as a new version; history is kept.         |
| browser: `v3 available` with a switch on the pinned thread                | The member sees it in the thread header (KOBE-420).                |
| browser: one click on Switch (`version_switched=3`); next run `:3`        | The click moves the thread; its next run uses v3 (KOBE-420).       |

## ac-2 Skills: scan, team-admin review, hash blocklist (U9, KOBE-79/80/81/82)

**Scenario.** The Builder uploads a team skill (a zip: `SKILL.md` and `scripts/fetch.sh`, which
runs `curl`). An agent that lists the skill is published. m1 runs it before review, after the team
admin approves it, and after the Owner blocklists the bundle's hash, in a new thread and in the
live thread that had loaded it.

| Check                                                                                                                                 | What it proves                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| upload `201`, `review=pending:flagged=true`; queue row with a `network` finding in `scripts/fetch.sh`                                 | The scanner flags the network call; it waits for the team admin. |
| before review: no bundle with its hash in the run's `run.start`, `context.omitted skill:<slug>:not_approved`, the model never sees it | An unreviewed team skill is not used in a run.                   |
| `decision=200:approved`; then the bundle is in `run.start`, nothing omitted, Pi lists it, its files are in the sandbox's skills store | Approval makes it usable.                                        |
| blocklisted: new thread and the live thread both get no bundle and `…:blocklisted`                                                    | A blocklisted hash never loads, not even where it was loaded.    |
| re-upload of the same bytes: `422 skill_blocklisted` (team, and another member's personal)                                            | The hash is refused anywhere on the site.                        |

`run.start` is read from `sandbox_commands` (what the server handed the sandbox); it is the list
Pi is launched with (`--skill` per bundle, `services/sandbox-agent/src/pi/pi-launch.ts`).

## ac-3 Projects: read-only files, private until shared (U10, KOBE-162/163)

**Scenario.** The team admin creates a project, adds m1 and m2, and uploads `docs/brief.txt`. In a
project thread, m1's agent reads the file under `/workspace/projects/<slug>/` and tries to append
to it, create a file next to it and remove it. m2 then tries the thread before and after m1
shares it with the project.

| Check                                                                                         | What it proves                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| the file's text read; `APPEND=DENIED`, `CREATE=DENIED`, `REMOVE=DENIED`                       | Project files are mounted read-only in the member's sandbox. |
| m2: `404 thread_not_found`, not listed                                                        | A project thread is private to its author until shared.      |
| shared: `200 read_only=true`, its entries, listed                                             | Sharing makes it readable to project members.                |
| `403 read_only` on post and rename; fork `201`, private and writable, invisible to the author | Readable and forkable, not writable.                         |
| unshared: `404` at once                                                                       | Sharing is revocable.                                        |

## ac-4 Memory: Memory updated + Undo; project memory asks (U10, KOBE-155..158)

| Check                                                                                                               | What it proves                                                               |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `memory.updated` `user:<doc>:<path>:v1:none`, then `…:v2:1`                                                         | A `remember` write is announced with what Undo needs.                        |
| restore version 1: `200`, the content is v1's again, `current_version=3`                                            | Undo reverts the doc (as a new version).                                     |
| browser: the thread shows the "Memory updated" chip with Undo                                                       | The member sees it in the chat.                                              |
| project write: `approval.requested` for `remember`, `doc_before_decision=absent`, then `memory.updated` `project:…` | A project-memory write waits for an approval and applies only once approved. |
| a second project write denied: the doc never appears                                                                | Denial applies nothing.                                                      |

## ac-5 CSV → chart under CSP; the sandbox is lost and nothing is (U3, U15)

**Scenario.** m1 opens a thread with the gallery agent Kobe (data-analysis and charts skills; the
former Data Analyst agent was folded into Kobe by KOBE-254) and uploads `sales.csv`. The agent runs
Python on `/workspace/uploads/<thread>/sales.csv`, then creates an HTML chart artifact whose
inline script tries `fetch()` to an outside address, then shares a copy of the CSV with
`share_file`. Then the sandbox is lost twice: **deleted** (its pod and workspace volume deleted
while it runs, as when a node goes) and **overnight** (it hibernates, then its volume is deleted).

| Check                                                                                                                                                                                                                                                                   | What it proves                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| upload `201`, object key under `teams/<team>/threads/<thread>/`, the object store holds it whole                                                                                                                                                                        | The upload lands in S3 first.                                                   |
| the CSV header and `G3TOTALS {"east": 50.25, "north": 150.5, "south": 80.0}`                                                                                                                                                                                            | The file is in `/workspace/uploads/<thread>/`; Python ran on it in the sandbox. |
| `artifact.created …:v1`; the frame's CSP: `sandbox allow-scripts allow-forms`, no `allow-same-origin`, `default-src 'none'`, `connect-src 'none'`, `frame-ancestors 'self'`; `X-Frame-Options: SAMEORIGIN`                                                              | The artifact is served under a strict CSP.                                      |
| browser: in a same-origin iframe the script runs, three bars render, the origin is `null`, `fetch` is `blocked` by a `connect-src` violation, and no request left the page (a request that did would be answered by a Playwright route)                                 | The CSP holds in a real browser.                                                |
| `file.shared` with the CSV's size                                                                                                                                                                                                                                       | The shared file exists before the loss.                                         |
| per loss: the next turn completes on a new pod and a new volume; overnight: `sandbox.waking`; `history?` echoes the earlier turns; `/workspace/.kobe/sessions/<thread>.jsonl` exists again; the server logged `Pi session lost; restoring from Postgres` for the thread | Pi's JSONL is rebuilt from Postgres and the conversation continues.             |
| every entry id from before is still there; the artifact list and content hash, the shared file's bytes and the upload object are unchanged                                                                                                                              | History, artifacts and shared files are intact.                                 |

The browser checks' control: against the same page served without the CSP header, the same script
reports `fetch=allowed`, `origin=http://…` and one beacon hit (checked when the script was written).

### Why a CSP response header satisfies "srcdoc carries the injected CSP"

The KOBE-231 brief asks for a CSP `<meta>` tag injected into the artifact's `srcdoc`. The product
does not build artifacts that way: the chat embeds `/v1/artifacts/:id/versions/:n/frame` in an
`<iframe>`, and the server sends the CSP as a **response header** on that frame. The criterion is
what the CSP enforces (U3: the HTML artifact renders "under a strict CSP"), and the header enforces
more than a meta tag could: a meta CSP cannot set `sandbox` (no same-origin access, an opaque
origin) or `frame-ancestors`, and it applies only from the point the parser reaches it. The gate
therefore asserts the header's directives over HTTP and, in Chromium, that the embedded frame's
script runs while its `fetch()` is blocked by a `connect-src` violation and no request leaves the
page. Accepted by the coordinator (2026-10-18); on Chris's gate-review list as a wording difference
between the brief and the product.

## Expected failures

A check of a product failure that is filed but not fixed prints `XFAIL <check>: got [...]
(<reason>)` and does not fail the run, so the merge queue stays green; `KOBE_GATE_STRICT=1` makes it
an ordinary `FAIL` (use it for the sign-off run). When it starts passing it prints `XPASS` and
fails, so the marker is removed with the fix. Current ones, with their evidence, are in
[docs/ledger/KOBE-231.md](../ledger/KOBE-231.md) under "Product failures found". None is open:
the version badge (KOBE-420) was fixed on the same branch and its checks are ordinary ones.

## What this does not prove

- The chat's own artifact panel: the browser check embeds the frame the way the chat does (a
  same-origin `<iframe>` of `/frame`), not by opening the panel.
- Thread search after the loss (U15 "list and search from Postgres instantly"): the thread and its
  entries are read from the API, search is not exercised here.
- Egress from the chart's sandbox run (U3 "no egress unless enabled"): Gate 2 ac-2 proves the
  egress proxy's default deny.

## Results

_CI run and real-cluster run: pending._
