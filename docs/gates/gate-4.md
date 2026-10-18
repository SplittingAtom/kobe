# Gate 4: v1.0 verification, all sixteen user stories (KOBE-4)

Evidence harness for the v1.0 gate (umbrella spec, KOBE-4): _all sixteen user stories (§4, U1–U16)
pass end to end on k3d (CI) and on the real cluster; backup → fresh cluster → restore round-trips;
the chart refuses to run agents without a gVisor or Kata RuntimeClass._ `e2e/gate4.sh` (KOBE-232)
gives one verdict per story. It changes no product code; a failing check stays and is filed.

A story is proven by **parts**. Where an earlier gate already proves part of a story, that gate's
own run is the evidence (e2e/gate1.sh, gate2.sh, gate3.sh, unchanged); the checks no earlier gate
makes are in `e2e/gate4/stories.sh`; U16's backup half is `e2e/gate4-restore.sh` (KOBE-233). A part
is one section of a run's output, from its `==> ` header to the next. It passes when it has at
least one `ok` and no `FAIL`, `INVALID`, `XPASS` or `NOTRUN` line; a story passes when all its
parts do. A part whose only failures are expected ones (`XFAIL`, a filed product failure) makes
the story `XFAIL`: not proven, but CI stays green; `KOBE_GATE_STRICT=1` turns it into `FAIL` for a
sign-off run.

## Running it

```bash
# CI: shards gate1, gate2, gate3 (their gates) and gate4 (e2e/gate4/stories.sh) keep their output;
# the `stories` job then gives the verdict from those logs, without a cluster:
KOBE_GATE4_VERDICT_ONLY=1 KOBE_GATE4_LOGS=<dir with gate1.log gate2.log gate3.log gate4.log restore.log> e2e/gate4.sh

# k3d by hand, everything in one go (after the gate1-prep install):
KOBE_E2E_SHARD=gate1-prep KOBE_IMAGE_TAG=<tag> e2e/run.sh && e2e/gate4.sh

# the real cluster's install, with a real model and a real OAuth MCP server (see U7)
KUBECTL='sudo k3s kubectl' HELM='sudo -E helm --kubeconfig /etc/rancher/k3s/k3s.yaml' \
KOBE_GATE4_CONTEXT=<context name> KOBE_GATE4_NS=kobe-gate1 KOBE_GATE4_RELEASE=kobe \
KOBE_GATE4_CHART=<the chart the install runs> \
KOBE_GATE4_OWNER_EMAIL=<the Owner> KOBE_GATE4_OWNER_PASSWORD=<the Owner's password> \
KOBE_GATE4_MODEL=<catalog alias> KOBE_GATE4_MAILPIT=<the install's Mailpit URL> \
KOBE_GATE4_MCP_URL=<https MCP URL> KOBE_GATE4_MCP_NAME=<connector name> KOBE_GATE4_MCP_TOOL=<a read-only tool> \
KOBE_GATE4_FAKE_INFRA=1 KOBE_GATE4_TOTP_REQUIRE=1 KOBE_GATE4_RUNC_CLASS=1 KOBE_GATE_STRICT=1 \
  e2e/gate4.sh
```

Run on the real cluster this way, `e2e/gate4.sh` runs Gate 1 (steps `probe chat-real chat-stream
interrupt`, no cold-start trials), Gate 2 (`mcp budget replicas egress break-glass`), Gate 3 (all
five) and the stories script, each once, into `KOBE_GATE4_OUT` (or a temporary directory), then the
verdict. `KOBE_GATE4_LOGS=<dir>` reuses runs already made (a log present there is not run again).
Each gate takes its own `KOBE_GATE<N>_*` variables from the `KOBE_GATE4_*` ones.

| Variable                                           | Default                | Meaning                                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KOBE_GATE4_STORIES`                               | `U1` … `U16`           | The stories to run and judge.                                                                                                                                                                |
| `KOBE_GATE4_LOGS` / `_OUT`                         | none / a temporary dir | Logs to reuse / where the runs write theirs.                                                                                                                                                 |
| `KOBE_GATE4_VERDICT_ONLY`                          | 0                      | 1: no runs, only the verdict from `KOBE_GATE4_LOGS`.                                                                                                                                         |
| `KOBE_GATE4_FAKE_INFRA`                            | 1 on k3d, else 0       | Namespace `kobe-gate4-infra` with the fake OAuth MCP server and the Orbit test model, and one `helm upgrade` (below).                                                                        |
| `KOBE_GATE4_MCP_URL` / `_NAME` / `_TOOL` / `_ARGS` | none (the fake server) | U7 against a real OAuth MCP server: its URL, the connector name, a read-only tool and its arguments.                                                                                         |
| `KOBE_GATE4_MCP_AUTHORIZE_CMD_M1` / `_M2`          | none                   | A command that gets the authorization URL as `$1` and prints the redirect back to Kobe; without it a person connects in the browser (the script waits `KOBE_GATE4_MCP_CONSENT_WAIT`, 600 s). |
| `KOBE_GATE4_TOTP_REQUIRE`                          | 1 on k3d, else 0       | U1's 2FA part turns "require 2FA" on for a moment, which holds every user without TOTP.                                                                                                      |
| `KOBE_GATE4_RUNC_CLASS`                            | 1 on k3d, else 0       | U16 creates and deletes a cluster-scoped RuntimeClass `kobe-gate4-runc` (handler `runc`).                                                                                                    |
| `KOBE_GATE4_MAILPIT`                               | the dev Mailpit        | Where the invitation email is read (Mailpit's API).                                                                                                                                          |
| `KOBE_GATE4_EVAL_MAX_ASR`                          | `0.5`                  | The team's eval threshold for U8.                                                                                                                                                            |
| `KOBE_GATE4_RESTORE_HELM`                          | 0 on k3d, 1 else       | Restore the release's saved values on exit.                                                                                                                                                  |

**What the stories script creates.** Users `gate4-{ga,gb,m1,m2,m3,mt}@gate4.test` in team `gate4-a`
(admin, Builder, members) and `gate4-gz@gate4.test` (admin of `gate4-b`); per run, an invitee
`gate4-invitee-<nonce>@gate4.test`, agents, a schedule (deleted), connectors `gate4-oauth` (and the
real one), the users' grants (m1's revoked), catalog entry `orbitvuln` and its provider
`orbitfake`, and namespace `kobe-gate4-infra` (deleted on exit).

**What it changes, and undoes.** With `KOBE_GATE4_FAKE_INFRA=1`, one `helm upgrade` from the
release's saved values (`helm get values -o yaml`, `--reset-values`, never `--reuse-values`) adds
the fake OAuth server to the MCP proxy's allow-lists (plain HTTP, port 80, its `/32`, its
namespace), lets Bifrost reach the test model's namespace, and sets
`server.connectorRefreshSeconds=60` (drift is found within a minute); restored on exit on a real
cluster. U1 puts the "require 2FA" setting back to what it was; U11 removes the member budget;
U8 turns the team's eval gate off again.

## The stories and their parts

| Story | Parts (log: section)                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------ |
| U1    | stories: U1                                                                                            |
| U2    | gate1: cross-team probe; gate1: concurrency, real sandboxes (own pods, own namespaces); stories: U2    |
| U3    | gate3: ac-5 (CSV upload → chart under CSP); gate3: browser (ac-5 lines)                                |
| U4    | gate1: concurrency with streamed answers (refresh mid-run resumes from the last seq)                   |
| U5    | stories: U5                                                                                            |
| U6    | gate2: ac-3 (no MCP write without a valid signed approval); stories: U6                                |
| U7    | stories: U7                                                                                            |
| U8    | gate3: ac-1 (pinning, switch, rollback); gate3: browser (ac-1 lines); stories: U8 (Orbit)              |
| U9    | gate3: ac-2                                                                                            |
| U10   | gate3: project setup, ac-3, ac-4; gate3: browser (ac-4 lines)                                          |
| U11   | gate2: ac-1 (100 %: the step finishes, then the stop); gate2: replicas; stories: U11 (80 %, dashboard) |
| U12   | gate2: ac-2                                                                                            |
| U13   | gate2: ac-4                                                                                            |
| U14   | stories: U14                                                                                           |
| U15   | gate1: killing a sandbox mid-run; gate3: ac-5 (deleted), ac-5 (overnight); stories: U15 (search)       |
| U16   | stories: U16 (chart refusal); gate1: concurrency, real sandboxes (first chat under gVisor); restore    |

## The stories script's checks

**U1.** The Owner invites a new address (`POST /v1/site/invites`); the email is read from Mailpit
and its `invite#token=` link accepted with a password; the password signs in; before any team
invitation no team is visible; the team admin invites them to `gate4-a` and they accept; only
`gate4-a` is listed and team `gate4-b`'s data is refused. They register a passkey (a software
WebAuthn authenticator, ES256, user verification set, as in the server's own tests) and a fresh
session signs in with the passkey alone. 2FA: the Owner turns "require 2FA" on; the user is held at
`403 two_factor_enrollment_required`, enrolls TOTP and is let in; a new sign-in with the password
alone gets `twoFactorRedirect` and no session, with the code it gets one. The Owner has no TOTP and
would be held too, so the previous value is written back to `site_settings` directly (the API
cannot undo it then).

**U2.** A member of `gate4-a` joins `gate4-b`; a personal memory doc written in `gate4-a` is listed
there and not in `gate4-b`.

**U5.** In one thread: a run that sleeps in a tool; a second message while it runs is queued (201,
`queued: true`), with one running run in the thread; Steer is accepted, applied (`steer.applied`),
and the model gets the steer text in the same run; the queued run starts only after the first ends.
Stop: a run whose model never answers (`kobe-slow-start`) is cancelled and ends `run.interrupted`
(`cancelled`) within seconds.

**U6.** `create_artifact` (risk `write`) asks: the card has the tool, its risk and the exact input;
the member allows it with a remember-rule (the first scope Kobe offers); the artifact holds exactly
the approved content; the approval row is `allowed` and signed (`token_kid`, `input_hmac`). The rule
is listed in "my rules"; the next call does not ask; revoking the rule (`204`) makes it ask again.
That approval's TTL is one hour (`expires_at - created_at`); its expiry is then moved to now in
Postgres (the harness cannot wait an hour), and the broker expires it (`approval.resolved` expired,
cause `ttl`) and ends the run visibly (`run.failed` `approval_expired` with the 1-hour message).

**U7.** One OAuth MCP connector registered by the Owner (its tools pinned) and enabled for the team;
two members each connect their own account through the full OAuth flow (PKCE, resource indicator,
`iss` checked by Kobe; on k3d the fake authorization server consents at once). Each member's tool
call through the MCP proxy reaches the server with that member's own token (the fake server
answers with the token's subject). Both members' stored tokens are opened from Kobe's sealed store
with the site key (in a server pod, never printed) and the full Gate 2 secret scan
(`e2e/gate2/scan.sh`, its controls included) runs over **both** sandboxes with those values added:
neither token is anywhere in either sandbox. m1 revokes: m1's call no longer reaches the server
with m1's token, m2's still does. Drift (fake server): `create_thing` changes its description; the
next re-probe marks it drifted; a new run offers `get_thing` but not `create_thing`; after a site
admin re-approves it, it is offered again.

**U8.** A published version exports (`GET /v1/agents/:id/versions/1/orbit`) as YAML that parses and
validates against Orbit's experiment schema at the pinned release (`orbit-schema.ts`, the twin of
CI's check with Orbit's own loader) and carries the agent's prompt. With the team's eval gate on at
threshold 0.5, publishing an agent whose model is the Orbit test model `fake-vulnerable` (it obeys
instructions injected into tool data) answers 202, the eval Job runs (the `kobe-orbit-eval` image),
scores attacks above the threshold and blocks: no version is published.

**U11.** A member's daily token budget of 1.2 M; the scripted tool step reports a 1 M-token prompt:
the run completes (under 100 %) and the member's budget status says `warning` at 80–99 %. The team
dashboard has the member's row, rows by agent and by model.

**U14.** A daily schedule (12 h away) whose prompt writes a file; its next run is pulled forward in
Postgres. It fires; the run is `trigger schedule`, `approval_mode auto`, owned by the member; the
thread carries the schedule (Scheduled); the write that would ask was skipped
(`scheduled_run_no_prompt`) and reported in `run.completed`; the member has a `schedule.run.*`
notification.

**U15.** With the member's sandbox hibernated, the thread list and full-text search return the
thread, both in under 3 s, and the sandbox stays asleep.

**U16.** `helm upgrade --dry-run=server` (lookups run, nothing applied) refuses a RuntimeClass that
does not exist and one whose handler is `runc` ("refuses to run agents"); the running sandboxes use
`gvisor` (or `kata*`).

## U7 on the real cluster: which OAuth MCP server

CI uses `e2e/lib/fake-oauth-mcp.js`, a port of the server tests' fake authorization server
(protected resource metadata, AS metadata, dynamic client registration, PKCE S256, RFC 8707
resource, RFC 9207 `iss`) with an MCP endpoint. For the real run the server must do the same over
HTTPS, with two separate accounts for the two members. **Decision: Linear's remote MCP server
(`https://mcp.linear.app/mcp`, OAuth 2.1 with dynamic client registration)**, with Notion's
(`https://mcp.notion.com/mcp`) as the fallback; registration fails clearly (`oauth_unsupported`)
if a server does not meet Kobe's checks. Pick a read-only tool of the server for `KOBE_GATE4_MCP_TOOL` (for Linear, for example
`list_teams`). Without `KOBE_GATE4_MCP_AUTHORIZE_CMD_*`, sign in to Kobe as `gate4-m1@gate4.test`
and `gate4-m2@gate4.test` (the fixtures' password) and connect the connector while the script waits.
The drift part runs against the fake server in either case (`KOBE_GATE4_FAKE_INFRA=1`), because a
real server's tools cannot be changed on demand.

## What this does not prove

- U1's passkey through a browser's own authenticator UI: the software authenticator produces the
  same WebAuthn JSON a browser does, against Kobe's real endpoints.
- U6's real hour: the TTL is read from the row and the expiry moved to now.
- U14's real Monday: the next run is pulled forward, as in the KOBE-181 e2e.

## Verdict

_Filled in from the CI run and the real-cluster run._

## Results

_CI run and real-cluster run: pending._
