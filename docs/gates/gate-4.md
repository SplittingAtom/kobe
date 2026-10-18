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
Each gate takes its own `KOBE_GATE<N>_*` variables from the `KOBE_GATE4_*` ones. U16's `restore`
part is `e2e/gate4-restore.sh`: on k3d `e2e/gate4.sh` runs it last (it deletes the cluster); on a
real cluster it is a run of its own (see [Backup → fresh site → restore](#backup--fresh-site--restore-u16-kobe-233)),
whose log goes into `KOBE_GATE4_LOGS` as `restore.log`.

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

## Backup → fresh site → restore (U16, KOBE-233)

`e2e/gate4-restore.sh` proves KOBE-4 ac-3 (_backup → fresh cluster → restore round-trips_) and
U16's "kobe backup/restore round-trips Postgres + S3". Its sections `==> restore: …` are U16's
`restore` part; its `==> install: …` sections time the clean install (below). CI runs it as the
shard `restore`; `e2e/gate4.sh` runs it last on k3d (it deletes the cluster).

```bash
# CI (shard `restore`), or k3d by hand: needs the images (KOBE_IMAGE_ARCHIVES=<dir of *.tar>, or a
# Docker engine to build them), the CLI built (pnpm --filter '@kobe/cli...' run build) and the
# PostgreSQL 17.6+ client tools on PATH (or KOBE_PG_BIN_DIR)
KOBE_IMAGE_TAG=<tag> e2e/gate4-restore.sh

# a real cluster, into fresh namespaces (not run yet: needs the go-ahead and a quiet cluster)
KUBECTL='sudo k3s kubectl' HELM='sudo -E helm --kubeconfig /etc/rancher/k3s/k3s.yaml' \
KOBE_GATE4_RESTORE_TARGET=namespace KOBE_GATE4_RESTORE_CONTEXT=<context name> \
KOBE_GATE4_RESTORE_NS=kobe-restore KOBE_GATE4_RESTORE_DEPS_NS=<namespace of deploy/pg> \
KOBE_GATE4_RESTORE_DB_SECRET=<namespace>/<Secret with app-url and migrate-url on that Postgres> \
KOBE_GATE4_RESTORE_VALUES=<a values file: images, S3 bucket and Secret, SMTP, ingress TLS> \
KOBE_GATE4_RESTORE_COPY_SECRETS='<namespace>/<each Secret the values file names>' \
KOBE_GATE4_RESTORE_HOST=<a host name of its own> KOBE_IMAGE_TAG=<the images' tag> \
KOBE_S3_ENDPOINT=<S3 URL> KOBE_S3_BUCKET=<bucket> KOBE_S3_ACCESS_KEY_ID=<id> KOBE_S3_SECRET_ACCESS_KEY=<key> \
  e2e/gate4-restore.sh
```

| Variable                               | Default                           | Meaning                                                                                                    |
| -------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `KOBE_GATE4_RESTORE_TARGET`            | `k3d` on a k3d context            | `k3d`: delete this cluster and restore into a new one. `namespace`: source `<ns>-src`, target `<ns>`.      |
| `KOBE_GATE4_RESTORE_NS` / `_RELEASE`   | `kobe-dev` / `kobe`               | The target namespace (`namespace`: required, new) and the release name.                                    |
| `KOBE_GATE4_RESTORE_CHART` / `_VALUES` | `charts/kobe` / `dev/values.yaml` | The chart and the values both sites install with.                                                          |
| `KOBE_GATE4_RESTORE_DEPS_NS`           | `kobe-deps`                       | Where `deploy/pg` runs (superuser `postgres`): row counts, the backup role, (namespace) the new databases. |
| `KOBE_GATE4_RESTORE_DB_SECRET`         | none                              | `namespace` only: app and owner URLs on that Postgres; each site gets a new database with those roles.     |
| `KOBE_GATE4_RESTORE_COPY_SECRETS`      | none                              | `namespace` only: Secrets (`ns/name`) copied into both namespaces.                                         |
| `KOBE_GATE4_RESTORE_HOST`              | the values file's                 | `namespace` only: the ingress host of both sites (one after the other; same host, as passkeys need).       |
| `KOBE_GATE4_RESTORE_CLI`               | `node packages/cli/dist/cli.js`   | The operator CLI, run on this machine through `kubectl port-forward`.                                      |
| `KOBE_GATE4_SETUP_BUDGET`              | `1200`                            | Seconds allowed from `helm install` to the first assistant token (spec §8: 20 minutes).                    |

**What it does.** (1) Installs a source site from clean state (k3d: `dev/postgres.yaml`,
`dev/s3.yaml`, `dev/mailpit.yaml` as the external Postgres, S3 and SMTP; the chart with
`dev/values.yaml`), runs first-run setup with the setup token, adds a model provider (the e2e fake
upstream) and the `fast` catalog entry, creates team `gate4-r` with an admin and a member, and times
the member's first chat. (2) Gives it: a thread with an upload, an HTML artifact, a shared file and
a workspace file synced to S3; a user memory doc; a project with a file; a team skill; an API-key
connector grant (the connector row is inserted as Gate 2 does; the grant goes through `PUT
/v1/connector-grants/:id`, sealed by the product). It records what the API returns for each and
the audit chain head (`GET /v1/site/audit/integrity`). (3) Saves the auth and envelope Secrets,
stops the server and scheduler, counts every team table's rows (superuser, `team_id NOT NULL` with
RLS, minus the backup's documented exclusions), creates a `BYPASSRLS` + `pg_read_all_data` backup
role and runs `kobe backup` with a fresh backup key. (4) Deletes the site: on k3d the whole
cluster, after copying the bucket's objects out (`e2e/lib/s3-mirror.mjs`; the k3d S3 fixture lives
in the cluster, and a real site's bucket survives a lost cluster); in `namespace` mode the release,
its namespace and its team namespace. (5) Creates a fresh site (k3d: `scripts/dev-cluster.sh`,
images, the same fixtures; the objects copied back, keys, sizes and ETags checked) with the Secrets
restored under new names (`auth.existingSecret`, `envelope.keySecret`, as docs/backup-restore.md
says), stops its writers and runs `kobe restore --expect-audit-head <source head>` as the owner
role. (6) Checks the restored site.

**The documented order.** The restore runs exactly as docs/backup-restore.md orders it: install,
stop the writers, `kobe restore`. The server's start has already written the gallery agents
(`site_agents`, their versions and audit events) and the background jobs' bookkeeping
(`site_settings`); the restore replaces those rows with the backup's and refuses anything else
(KOBE-422, `packages/db/src/startup-seeds.ts`). Only if that check fails does the run empty the
target's database, migrate it with the chart's own migration Job (`helm template --show-only
templates/migrate-job.yaml`, the server never started) and restore into that, so the later checks
still run against a real restore.

**The checks** (`==> restore:` sections): the backup has its four files and a fingerprint; the
restore names the same fingerprint, finds every S3 object present and unchanged, and verifies the
audit chain containing the source's head; every team table's row count equals the source's and the
signed manifest's; `platform.restore.completed` is logged once; users sign in again with their
passwords; the thread has every entry; the artifact, the shared file and the upload are the same
bytes; the memory doc, the project's file list and the skill bundle (bytes hashed against the
recorded content hash) are the same; the connector grant opens with the restored envelope key to
the stored API key, and not with a random key; the audit chain verifies through the API and runs
past the source's head; every object key in a `BLOB_REF_COLUMNS` column (and the skill bundles'
`storage_key`) resolves in the bucket; the thread's next turn completes in a new sandbox that wakes
for it, the model gets the earlier turns (`history?`), Pi's session file is in the new sandbox and
the server logged rebuilding it from Postgres; the workspace file is back in the new sandbox with
the same content; the project file is mounted there.

**Why `namespace` mode refuses while other Kobe servers run.** Every Kobe server converges every
namespace labelled `kobe.splittingatom.io/team-namespace=true` in the cluster
(`services/server/src/sandbox/team-reconcile.ts`), with its own release namespace in the sandbox
NetworkPolicies and RoleBindings. A second site in the same cluster therefore rewrites the first
site's team namespaces (its sandboxes lose their path to their own server until that server's next
reconcile). On the real cluster, run it only with `kobe-gate1`'s server scaled to 0 (and scale it
back afterwards: its reconcile at start and every `server.teamReconcileSeconds` puts its policies
back). The two sites here never run at once: the source is deleted before the target is
installed. The deps namespace's Postgres NetworkPolicy must admit both new namespaces.

**What this does not prove.** A restore onto a site of another version (not supported,
docs/backup-restore.md "Limits"); a backup taken while writers run (the CLI's snapshot makes that
consistent, but this run stops the writers so the counts can be compared exactly); objects deleted
or overwritten in the bucket after the backup (bucket versioning's job, D31); the 24-hour IP-erasure
pause and the legal-hold warning the restore prints. On k3d the "same bucket" is a copy made with
the S3 API (single-part objects, so ETags compare); on a real cluster it is the same bucket.

## Clean install timing (KOBE-233 ac-3)

The spec's install metric (§8) is _a clean single-node k3s with gVisor → first chat in ≤ 20
minutes following the docs_. The restore shard measures the chart path: from the start of
`helm install` (dependencies already up) to the first `text.delta` of the first member's first
chat, through first-run setup, a provider and catalog entry, a team and its default model, all
through the API as docs/install.md describes them; and, separately, the cluster
(`scripts/dev-cluster.sh`: k3s, gVisor, agent-sandbox). The manual path on the real cluster is
timed once by hand.

| Run                                 | Cluster with gVisor + agent-sandbox | `helm install` → first assistant token | Total     |
| ----------------------------------- | ----------------------------------- | -------------------------------------- | --------- |
| CI, k3d (shard `restore`)           | _pending the group CI run_          | _pending_                              | _pending_ |
| Real cluster, by hand (manual docs) | _pending_                           | _pending_                              | _pending_ |

**Doc fixes from walking docs/install.md to a first chat.** The install section ended at
`helm install`; the steps to the first chat (open `/setup` with the setup token from
`<release>-auth`, add a provider and a catalog model, create a team, enable a team default model,
start a chat) were only in the chart's NOTES and scattered over the Models section. Added
"First run: to the first chat" to docs/install.md.

## Verdict

_Filled in from the CI run and the real-cluster run._

## Results

_CI run and real-cluster run: pending._
