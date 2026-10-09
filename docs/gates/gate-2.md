# Gate 2: Safety verification (KOBE-2)

Evidence harness for the Phase 2 gate (umbrella spec, KOBE-2): _a team budget at 100% stops a run
after its current step; a blocked domain gives a "Request access" and enablement then works; a
tampered `kobe-policy` cannot execute an MCP write without a valid signed approval; break-glass
needs a second admin, notifies team admins and audits every read; a secret scan of a running
sandbox finds no provider keys or connector tokens._ Each criterion must hold on k3d (CI) and on the
real cluster. `e2e/gate2.sh` (KOBE-170) runs all five against an installed Kobe and prints one
`ok` / `FAIL` line per check with its evidence. It changes no product code. Where a check fails,
the check stays and the failure is filed; nothing here is weakened to pass.

## Running it

```bash
# k3d (CI shard `gate2`): the install and model setup first, then the suite
KOBE_E2E_SHARD=gate1-prep KOBE_IMAGE_TAG=<tag> e2e/run.sh && e2e/gate2.sh

# the real cluster's throwaway install (run where kubectl and helm reach it, e.g. on compute1)
KUBECTL='sudo k3s kubectl' HELM='sudo -E helm' KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
KOBE_GATE2_CONTEXT=<context name> KOBE_GATE2_NS=kobe-gate1 KOBE_GATE2_RELEASE=kobe \
KOBE_GATE2_CHART=~/kobe-gate1/repo/charts/kobe \
KOBE_GATE2_OWNER_EMAIL=owner@gate1.test KOBE_GATE2_OWNER_PASSWORD=<OWNERPW from creds.env> \
KOBE_GATE2_MODEL=<catalog alias enabled on the install> \
KOBE_GATE2_EXTRA_SECRETS_FILE=~/kobe-gate1/ollama.key \
  e2e/gate2.sh
```

| Variable                                      | Default             | Meaning                                                                                                    |
| --------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `KOBE_GATE2_NS` / `KOBE_GATE2_RELEASE`        | `kobe-dev` / `kobe` | Release namespace and name.                                                                                |
| `KOBE_GATE2_CONTEXT`                          | none                | Required for anything but a `k3d-*` kube context: the script signs sandbox tokens with the install's keys. |
| `KOBE_GATE2_CHART`                            | `charts/kobe`       | Chart for the one `helm upgrade` (proxy allow-lists). Use the chart the install runs.                      |
| `KOBE_GATE2_STEPS`                            | all five            | Subset of `budget egress mcp break-glass scan`.                                                            |
| `KOBE_GATE2_MODEL`                            | `fast`              | Catalog alias the team uses. `fast` is CI's scripted model; see "Real models" below.                       |
| `KOBE_GATE2_BUDGET_PROMPT` / `_EGRESS_PROMPT` | scripted            | Prompts that make a real model run a tool (the egress one runs the curl of the check).                     |
| `KOBE_GATE2_EXTRA_SECRETS_FILE`               | none                | Extra values to scan for, one per line: a provider key kept outside the cluster, connector tokens.         |
| `KOBE_GATE2_RESTORE_HELM`                     | 0 on k3d, 1 else    | Restore the release's saved values on exit.                                                                |
| `KOBE_GATE2_OWNER_EMAIL` / `_PASSWORD`        | CI owner            | The install Owner (first-run setup runs only on a fresh install).                                          |

**What it creates.** Users `gate2-{t1,t2,ia}@gate2.test`, team `gate2-a` (namespace
`kobe-team-gate2-a`, t2's sandbox), namespace `kobe-gate2-infra` (a TLS upstream pod and a
plain-HTTP fake MCP server), one connector row with its team enablement and a leased run, break-glass
grants (revoked at the end; they lapse after 15 minutes anyway), and the audit trail of all of it.
Re-running reuses the fixtures.

**What it changes temporarily, and undoes on exit.** The catalog model's price, only when it has
none (so one model call can use up a $0.01 budget); the test upstream in the install's egress
ceiling (only if it added it); the team's budget. One `helm upgrade` adds exactly the two fake
servers (as `/32` addresses plus a namespace selector) to the egress proxy's and MCP proxy's
allow-lists and enables plain HTTP and port 80 on the MCP proxy, which the fake server needs. It
starts from `helm get values -o yaml` with `--reset-values` (never `--reuse-values`), rolls the
proxies and server once, and on a real cluster is reverted from the saved values on exit. On a real
cluster, run it on a throwaway install, not on one with users.

## Verdict

_Filled in from the CI run and the real-cluster run; see the end of this file._

## ac-1 Budget at 100%: the step in flight finishes, then `run.budget_stopped`

**Scenario.** The team admin sets a $0.01 monthly budget; the member sends a prompt that makes the
model call `bash` (`sleep 3; echo step-done`). That one model call costs more than the budget.

| Check                                                             | What it proves                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `terminal=run.budget_stopped`, message contains "used up"         | The run is stopped by the budget, with the user-facing explanation.                        |
| a `tool.result` event comes before the terminal event             | The step in flight was not cut off: the tool call the model had started ran to its result. |
| `run_usage`: 1 row, status 200                                    | That step's model call is in the ledger, and no second model call was started afterwards.  |
| audit `run.budget_stopped` names the run; `models.budget.reached` | The stop and the budget reaching 100% are recorded (the team admin's audit view).          |
| a new message gets 429                                            | The budget also refuses new runs while it is used up.                                      |

**Does not prove.** That a model call already streaming is never cut (the stop takes effect at the
step boundary by design, D-spec: "after the current step"); budgets for several concurrent runs;
daily and token budgets (KOBE-42's tests cover them). With a real model the prompt must make the
model use a tool; if it answers in one step the run completes and the check FAILS (it cannot show a
stop). The price is a test price, not the model's real cost.

## ac-2 Blocked domain → Request access → enablement

**Scenario.** The upstream (a TLS server in `kobe-gate2-infra`) is in the install ceiling but not
enabled for the team. The member's sandbox runs `curl https://upstream/` through Pi's bash tool.

| Check                                                                      | What it proves                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| run completes; tool output shows the proxy's 403                           | The request went through the egress proxy (the only path) and was refused. |
| `egress.blocked` event with `request_access: true` for the domain          | The chat gets the "Request access" notice (the event the web UI renders).  |
| member `POST /v1/egress/requests` from the thread → `201 pending`          | Request access works for a member and is tied to the thread.               |
| team admin sees the request with its thread, approves (`200 approved`)     | Only the team admin decides; the decision is the enablement.               |
| the same curl on the same thread now gets the upstream's page (`s_server`) | Enablement reaches the egress proxy and the identical request succeeds.    |
| audit `egress.request.created` and `.decided`                              | Both steps are in the team's audit log.                                    |

**Does not prove.** That a member cannot approve (`egress-requests.db.test.ts`); that the ceiling
cannot be exceeded (`not_in_ceiling`, KOBE-38/39 tests); header injection (the KOBE-39 section of
`e2e/run.sh`). Pi's tool needs a model that runs the given command: with a real model set
`KOBE_GATE2_EGRESS_PROMPT` to a prompt that does.

## ac-3 Tampered `kobe-policy` cannot execute an MCP write without a valid signed approval

**Scenario.** In t2's running sandbox container: (a) try to tamper with the extension file and
directory; (b) behave as a sandbox whose policy extension never asks the server (`policy.check`) by
calling the MCP proxy directly with the sandbox's own `kobe.mcp-proxy` session token. A fake MCP
server counts every call it receives.

| Check                                                                                                     | What it proves                                                                                              |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| append to, add a file next to, `chmod`, remove, or move aside `kobe-policy` all DENIED; sha256 unchanged  | The sandbox user cannot alter the extension in place (root-owned, read-only image path).                    |
| forged token: 401                                                                                         | The proxy authenticates the session token itself.                                                           |
| unapproved write: `isError`, "Kobe denied this call"; the fake server's `create_thing` count is unchanged | A client that skips policy still cannot reach the remote write: the proxy asks the server about every call. |
| the read-only call reaches the server; no `Authorization` header ever does                                | The proxy path works and does not leak the sandbox's token upstream.                                        |
| audit `mcp.tool_call` denied, `approvalFailure: no_approval`                                              | The refusal is recorded with its reason.                                                                    |
| with a signed approval the same write runs once; a replay is refused; the server saw exactly one          | Approval is HMAC-bound to (run, tool call, canonical input) and single use.                                 |

**Does not prove.** That Pi loads the right extension (the image tests and the real-Pi tests in
`services/sandbox-agent` do) or what a replaced extension could do to Pi itself; the check stands on
the server-side enforcement, which holds for any client. The approval is stored and signed by the
harness with the install key (as `e2e/run.sh` KOBE-58 does), not clicked in the UI, and the run and
lease are a fixture, not a live Pi run. The fake server is plain HTTP, hence the allow-list upgrade.

## ac-4 Break-glass: second admin, team notified, every read audited

**Scenario.** A second install admin requests access to the team; the Owner approves; the requester
reads the team's threads, a thread and its entries; the grant is revoked.

| Check                                                                                | What it proves                                                                                       |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| request `201 pending`; own approval `403 self_approval_forbidden`                    | A request needs another admin (the install has two or more).                                         |
| read before approval `403 grant_not_active`                                          | No access without an approved grant.                                                                 |
| approval `200 active`, `selfApproved: false`, team admins queued                     | Two-person approval; the team's admins get a notification each.                                      |
| `break_glass_notifications`: `team_admin/approved/<status>`                          | The notification is durable. Delivery (`sent`) depends on the install's mail; the status is printed. |
| team admin's banner (`/v1/team/break-glass`) shows the active grant                  | The team side sees the access in product, not only by email.                                         |
| three reads → 200; three `governance.break_glass.read` audit events naming the grant | Every read is audited in the team's own log, attributed to the requester.                            |
| the same user with the team header on a normal route is refused                      | A grant is honored only by the break-glass read routes.                                              |
| revoke → read refused; `requested`, `approved`, `revoked` events in the team log     | Access ends at once; the whole story is in the team's audit view.                                    |

**Does not prove.** Mail delivery (CI has no SMTP: `pending` or `failed` rows are expected there);
legal hold (hidden reasons, KOBE-17 tests); expiry and the 24-hour request lapse (db tests); that
the only read path is the break-glass routes, enforced by RLS (the `packages/db` probe suite).

## ac-5 Secret scan of a running sandbox

**What is looked for (CI side only; values are never printed, sent into the sandbox or logged).**
Every value (12+ characters, per line) of every Kubernetes Secret in the release namespace and in
its dependencies' namespaces (internal signing, sealing and approval keys, database and S3
credentials, the Bifrost admin password, the setup token, ...); every provider API key, opened from
the sealed store in a server pod with the install's own key; and the lines of
`KOBE_GATE2_EXTRA_SECRETS_FILE`. Hits are reported by the secret's label and the file, never the
value. Also generic key shapes: `sk-...`, AWS, GitHub, Slack and Google keys, PEM private keys,
`Bearer` credentials and `scheme://user:password@` URLs.

**Where it looks.** The agent container of t2's running sandbox: every process's
`/proc/<pid>/environ` and `cmdline` that the agent user may read, plus the same dump taken by Pi's
bash tool, so Pi's own identity's processes are covered; the files sandbox code can write or that
are mounted (`/workspace`, `/tmp`, `/home`, `/run`, `/var`, `/etc`, `/opt/kobe`, every other mount
from `/proc/self/mountinfo`; files under 2 MiB, no apt caches); and the pod spec (no Secret volume,
no env from a Secret).

**Expected in the sandbox, and why.** Kobe's own session tokens for this sandbox: the bootstrap
ServiceAccount token (projected volume, short-lived, traded for session tokens) and the
JWTs derived from it (wire, model-gateway and egress-proxy audiences; the egress token reaches
Pi's tools as `HTTPS_PROXY` through the `BASH_ENV` script). They are how the agent authenticates
and are bound to this user, team and sandbox. The scan classifies every JWT: it passes only if
`iss` is `kobe-server` and `user_id`/`team_id` are this sandbox's; any other token FAILS. The
criterion is provider keys, connector tokens and internal keys, not Kobe's per-sandbox credentials.

Allow-listed by exact shape, nothing broader: the egress token in `HTTPS_PROXY`
(`scheme://<thread id>:<jwt>@proxy`, a Kobe credential for this sandbox; "egress token visible in
env output" is accepted LOW in `docs/ledger/KOBE-39.md`); the template in
`/opt/kobe/egress-env.sh` that builds that URL; the bootstrap token only when its audience is
exactly `kobe.sandbox-bootstrap` and its subject is a ServiceAccount of this team namespace (the
API server rejects that audience; any API-audience token would FAIL); and three library files
inside the image by exact path (pino's `docs/transports.md`, zod's `tests/*.test.ts`: example URLs
and the jwt.io sample token).

| Check                                                            | What it proves                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| N secret/key values collected, provider keys among them          | The scan has the install's real values to look for.                  |
| a canary in a process environment and in a file is found         | Positive controls: the dump and the search can find a planted value. |
| none of the values is in any process, file or cmdline copied out | The criterion.                                                       |
| no generic key shape; every JWT is this sandbox's own Kobe token | Keys the install does not know about are not there either.           |
| no Secret volume or secret-sourced env in the pod spec           | Nothing is mounted from a Secret.                                    |

**Does not prove.** Anything about processes whose environment the agent user cannot read
(other identities are covered only through Pi's bash tool, which needs the scripted model; with a
real model the scan covers the agent user's view and says so); the sandbox image's own layers
(Trivy and the image tests); secrets the install does not hold in the cluster or its sealed store
(add them with `KOBE_GATE2_EXTRA_SECRETS_FILE`); connector credentials, which have no store yet
(KOBE-59/100 only pin tools); values held only in memory of a process (not in its environ or
files); a secret that is shorter than 12 characters or whose encoding differs (base64 of a key).

## Real models

CI uses the scripted model (`fast`): `kobe-tool-step ...` makes one `bash` tool call and
`bash: <command>` runs a command, which makes ac-1, ac-2 and the Pi-side half of ac-5
deterministic. On a real install, set `KOBE_GATE2_MODEL` to an enabled catalog alias and the two
prompt variables so that the model runs a tool; the Pi-side scan is skipped (it needs the scripted
model to run a command).

## Results

_To be filled in: CI run link, per-criterion result on k3d, and the real-cluster run._
