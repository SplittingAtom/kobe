# Audit log

Kobe keeps one install-wide, append-only audit log in Postgres (spec D6, D31; KOBE-15). Install
admins (Owner, Admin) read all of it; team admins read their team's events. Each event records
metadata only: who did what, to which object, when, and from where. Secrets, tokens, passwords,
prompts and message text are never recorded.

## What is guaranteed

| Property                       | How                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Action and event agree         | `audit()` takes the transaction that performs the action. Both commit or both roll back. An invalid event (unknown action, a field outside the allowlist, wrong team scope, no actor) throws, so the action fails as well.                                                                                 |
| Append-only for the app        | The app role holds `INSERT` and `SELECT` on `audit_log`, nothing else (tenancy registry, applied by the migration runner). `UPDATE`, `DELETE` and `TRUNCATE` fail with `permission denied`.                                                                                                                |
| Append-only for the owner      | Triggers refuse `UPDATE`, `DELETE` and `TRUNCATE` for every role they fire for, including the schema owner.                                                                                                                                                                                                |
| Tampering is detectable        | Every row carries `seq` (gapless from 1), `prev_hash` and `hash = sha256(audit_log_canonical(row))`, where the canonical text includes `prev_hash`. The `BEFORE INSERT` trigger assigns them under a transaction-scoped advisory lock, so the chain follows commit order.                                  |
| Team events stay in team       | Inside `withTeam()`, an event can only be recorded for the active team (or for no team). The trigger enforces this.                                                                                                                                                                                        |
| Heads leave the box            | Every server replica logs the chain head (`seq`, `hash`, and a MAC under a key derived from the auth secret) at startup and every 5 minutes, after verifying the rows appended since its previous head. See [Anchoring the chain](#anchoring-the-chain).                                                   |
| Bounded unauthenticated writes | Failed sign-ins, 2FA challenges and reset requests are aggregated: per action, method and account (or "no account") and 5-minute window, the first is recorded as itself and the rest become one `auth.attempts.summarized` row. A flood from rotating addresses adds at most two rows per key and window. |
| Bounded lock waits             | An audited transaction without its own `lock_timeout` gets 5 s for the chain lock. When it expires the action rolls back and the API answers 503 `audit_busy` (retryable).                                                                                                                                 |

A superuser, or the owner after it drops the triggers, can still change rows. The chain makes that
visible. `verifyAuditChain()` (or `GET /v1/install/audit/integrity`) recomputes every hash and
reports the first row that was edited (`hash_mismatch`), removed (`gap`) or re-chained
(`prev_hash_mismatch`). The chain can't reveal two things on its own: a rewrite of every row from
some point onwards, and the removal of the newest rows. To catch those, compare the reported `head`
(`seq`, `hash`) with a copy kept outside the database. Audit export and SIEM forwarding (KOBE-19)
are the intended places to keep that copy. Until KOBE-19 ships, the server log carries it (see
[Anchoring the chain](#anchoring-the-chain)).

Why a hash chain and not only a sequence: a sequence shows that rows are missing, but it can't show
that a row was edited, and Postgres sequences leave gaps after rollbacks. The chained `seq` here is
gapless because it is assigned under the lock, not taken from a sequence.

**Throughput:** appends are serialized until commit. Make `audit()` the last write of a transaction
and keep audited transactions short. Appends need `READ COMMITTED`, the default. Under
`REPEATABLE READ` a stale chain head makes the insert fail with a duplicate `seq`; it never forks
the chain.

## Record format

One row per event. The fields are stable, so export (CSV/JSONL) and SIEM forwarding (syslog/OTLP)
can map them one to one:

| Field               | Type        | Meaning                                                                                              |
| ------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `seq`               | bigint      | Chain position and keyset cursor; gapless, increasing in commit order                                |
| `id`                | uuid        | Stable event id (for de-duplicating in a SIEM)                                                       |
| `at`                | timestamptz | Assigned by the database under the chain lock; never decreases along `seq`                           |
| `team_id`           | uuid / null | The team the event belongs to (team audit view); null for install-level events                       |
| `actor_kind`        | enum        | `user`, `agent` or `system`                                                                          |
| `actor_id`          | uuid / null | User or agent id; null for `system` and for unauthenticated attempts (failed sign-in, reset request) |
| `action`            | text        | Dotted event name from the taxonomy below                                                            |
| `category`          | text        | First segment of `action` (generated column, indexed with `seq` for category filters)                |
| `target`            | jsonb       | The action's allowlisted fields (below); ≤ 4 KB                                                      |
| `ip`                | inet / null | Client address of the request (X-Forwarded-For via the trusted proxies, as for rate limits)          |
| `user_agent`        | text / null | Client user agent, control characters removed, ≤ 256 characters                                      |
| `prev_hash`, `hash` | hex text    | The hash chain                                                                                       |

The read APIs also return the actor's current name and email when the actor is a user. Users are
never deleted.

## Team scoping

`audit_log` is install-wide (§5.4 marks it †) and has a nullable `team_id` column. It has no RLS.
The team view is `listTeamAuditEvents(tx, query)`, called inside `withTeam()`. The team is not a
parameter: the query matches `team_id` against the transaction's `kobe.team_id`, the setting team
RLS uses. Outside `withTeam` it returns nothing, and a `teamId` in the query is ignored. A
cross-team probe test checks each team's view against the table. It is the only way the team route
reads the log.
The alternative, a separate team table behind RLS, was rejected for three reasons:

- An event about a team is often an install-level act. Team creation, break-glass and legal hold
  are done by install admins. Install admins need these events in their log, and team admins need
  them in theirs. A second table would mean writing every such event twice, in two chains.
- Team RLS would hide team events from the install log. Install admins don't run inside a team
  context.
- The table holds no team content, only allowlisted metadata. So a missed filter would show
  metadata, not threads.

The team view also leaves out `ip`, `user_agent`, `prev_hash` and `hash`. The first two are
personal data of install admins and other members; the chain fields are for install admins
verifying it. Every team-scoped action requires `teamId` (enforced by `audit()`).

## Event taxonomy and field allowlist

The source of truth is `AUDIT_EVENTS` in `packages/db/src/audit/events.ts`. Each target is a
strict zod object, and unknown keys are rejected. A unit test fails if an action is missing from
this page, or if a field name suggests content or credentials. Scope `install` means no team.
Scope `team` means the team view shows the event. Scope `any` means team for team agents and
install for personal and gallery agents.

| Action                                       | Scope   | Target fields (allowlist)                                                                                                           | Recorded when                                                                                                                                    |
| -------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth.sign_in.succeeded`                     | install | `method` (password, totp, backup_code, passkey, invitation)                                                                         | A session is created                                                                                                                             |
| `auth.sign_in.failed`                        | install | `method`, `reason` (error code), `userId?`                                                                                          | First failed sign-in step per key and window (aggregated); `userId` only if the email names an account                                           |
| `auth.sign_in.two_factor_required`           | install | `method`                                                                                                                            | Password accepted, TOTP still outstanding (aggregated)                                                                                           |
| `auth.attempts.summarized`                   | install | `of`, `method?`, `userId?`, `suppressed`, `distinctIps`, `from`, `to`                                                               | The other attempts of one key in a 5-minute window, summarized (system)                                                                          |
| `auth.sign_out`                              | install | —                                                                                                                                   | Sign-out                                                                                                                                         |
| `auth.session.revoked`                       | install | `which` (one, others, all)                                                                                                          | The user revokes sessions                                                                                                                        |
| `auth.password.changed`                      | install | —                                                                                                                                   | Password change                                                                                                                                  |
| `auth.password.reset_requested`              | install | `userId`                                                                                                                            | Reset requested for an existing, active account (actor null; aggregated)                                                                         |
| `auth.password.reset`                        | install | `userId`                                                                                                                            | Reset completed                                                                                                                                  |
| `auth.two_factor.enabled`                    | install | —                                                                                                                                   | TOTP enrollment verified                                                                                                                         |
| `auth.two_factor.disabled`                   | install | —                                                                                                                                   | 2FA turned off                                                                                                                                   |
| `auth.two_factor.backup_codes_regenerated`   | install | —                                                                                                                                   | New backup codes                                                                                                                                 |
| `auth.passkey.added`                         | install | —                                                                                                                                   | Passkey registered                                                                                                                               |
| `auth.passkey.removed`                       | install | `passkeyId?`                                                                                                                        | Passkey deleted                                                                                                                                  |
| `identity.setup.completed`                   | install | `ownerUserId`                                                                                                                       | First-run setup created the Owner                                                                                                                |
| `identity.invitation.created`                | install | `invitationId`                                                                                                                      | Install invitation sent                                                                                                                          |
| `identity.invitation.resent`                 | install | `invitationId`                                                                                                                      | Re-sent (new token)                                                                                                                              |
| `identity.invitation.revoked`                | install | `invitationId`                                                                                                                      | Revoked                                                                                                                                          |
| `identity.invitation.accepted`               | install | `invitationId`, `userId`                                                                                                            | Account created from it (actor: the new user)                                                                                                    |
| `identity.user.deactivated`                  | install | `userId`                                                                                                                            | Deactivation                                                                                                                                     |
| `identity.user.reactivated`                  | install | `userId`                                                                                                                            | Reactivation                                                                                                                                     |
| `identity.install_role.granted`              | install | `userId`, `role` (admin)                                                                                                            | Admin granted                                                                                                                                    |
| `identity.install_role.revoked`              | install | `userId`, `role` (admin)                                                                                                            | Admin revoked                                                                                                                                    |
| `identity.ownership.transferred`             | install | `fromUserId`, `toUserId`                                                                                                            | Ownership transfer                                                                                                                               |
| `identity.team.created`                      | team    | `slug`, `name`, `adminUserId`                                                                                                       | Team created with its first team admin                                                                                                           |
| `identity.team.renamed`                      | team    | `name`                                                                                                                              | Team renamed                                                                                                                                     |
| `identity.team_invitation.created`           | team    | `invitationId`, `role`                                                                                                              | Team invitation sent or renewed                                                                                                                  |
| `identity.team_invitation.revoked`           | team    | `invitationId`                                                                                                                      | Revoked by a team admin                                                                                                                          |
| `identity.team_invitation.accepted`          | team    | `userId`, `role`, `invitedBy`                                                                                                       | Invitee joined (actor: the invitee)                                                                                                              |
| `identity.team_invitation.declined`          | team    | —                                                                                                                                   | Invitee declined (actor: the invitee)                                                                                                            |
| `identity.member.role_changed`               | team    | `userId`, `from`, `to`                                                                                                              | Team role changed                                                                                                                                |
| `identity.member.removed`                    | team    | `userId`, `role`                                                                                                                    | Member removed                                                                                                                                   |
| `install.settings.updated`                   | install | `setting` (require_two_factor), `value`                                                                                             | Install setting changed                                                                                                                          |
| `platform.isolation.changed`                 | install | `from`, `to`, `runtimeClass?`, `handler?`, `replica`                                                                                | A server replica lost or regained isolation, or started without it (system)                                                                      |
| `platform.restore.completed`                 | install | `backupCreatedAt`, `tables`, `rows`, `operator`, `auditHeadSeq?`, `auditHeadHash?`                                                  | `kobe restore` loaded and verified a backup (system, same transaction)                                                                           |
| `governance.break_glass.requested`           | team    | `grantId`, `scope` (team, user, thread), `subjectUserId?`, `threadId?`, `legalHold`, `durationMinutes`, `recipients`                | An install admin requested break-glass access to the team (D10; the reason stays in the grant)                                                   |
| `governance.break_glass.approved`            | team    | as requested, but `expiresAt`, `selfApproved` and `teamAdmins` (0 = no team admin could be told) instead of `durationMinutes`       | A second install admin approved (or a single-admin install self-approved, flagged)                                                               |
| `governance.break_glass.denied`              | team    | `grantId`, `recipients`                                                                                                             | Another install admin denied the request                                                                                                         |
| `governance.break_glass.revoked`             | team    | `grantId`, `wasActive`, `recipients`, `teamAdmins?`                                                                                 | Withdrawn while pending, or revoked during the window                                                                                            |
| `governance.break_glass.expired`             | team    | `grantId`, `wasActive`, `recipients`, `teamAdmins?`                                                                                 | The window ended, or the request lapsed undecided after 24 h (system)                                                                            |
| `governance.break_glass.notification_failed` | team    | `grantId`, `recipientUserId`, `event`, `attempts`                                                                                   | A queued break-glass email gave up after its retries (system)                                                                                    |
| `governance.break_glass.read`                | team    | `grantId`, `object` (thread_list, thread, thread_entries), `threadId?`                                                              | **Every** read under a grant, in the read's own transaction (actor: the requesting admin). Under legal hold no event names the subject or thread |
| `agent.created`                              | any     | `agentId`, `scope`, `slug`, `source` (json, import, fork), `forkedFrom?`                                                            | Agent created, imported from a file, or forked                                                                                                   |
| `agent.updated`                              | any     | `agentId`, `scope`, `slug`, `revision`, `source` (json, import)                                                                     | Draft replaced                                                                                                                                   |
| `agent.deleted`                              | any     | `agentId`, `scope`, `slug`                                                                                                          | Never-published agent deleted (a published one is archived)                                                                                      |
| `agent.status_changed`                       | any     | `agentId`, `scope`, `slug`, `status`                                                                                                | Suspended or reactivated                                                                                                                         |
| `agent.exported`                             | any     | `agentId`, `scope`, `slug`                                                                                                          | Agent file downloaded                                                                                                                            |
| `agent.published`                            | any     | `agentId`, `scope`, `slug`, `version`, `draftRevision`                                                                              | Draft published as a new immutable version with a frozen tool manifest (D19)                                                                     |
| `agent.rolled_back`                          | any     | `agentId`, `scope`, `slug`, `version`, `fromVersion`                                                                                | An older version republished as the new current version                                                                                          |
| `agent.archived`                             | any     | `agentId`, `scope`, `slug`                                                                                                          | A published agent deleted: archived instead, its versions stay pinned                                                                            |
| `agent.unarchived`                           | any     | `agentId`, `scope`, `slug`                                                                                                          | Archived agent restored                                                                                                                          |
| `policy.rule.created`                        | any     | `ruleId`, `scope` (install, team, user), `effect`, `toolGlob`, `argPatternEntries`, `expiresAt`                                     | Tool rule created (install floor: install; team and user rules: team)                                                                            |
| `policy.rule.updated`                        | any     | as `policy.rule.created`                                                                                                            | Tool rule replaced                                                                                                                               |
| `policy.rule.deleted`                        | any     | as `policy.rule.created`                                                                                                            | Tool rule deleted, including a member revoking their own remember-rule                                                                           |
| `policy.settings.updated`                    | install | `setting` (prompt_sandbox_writes), `value`                                                                                          | Install policy switch changed                                                                                                                    |
| `egress.ceiling.added`                       | install | `domain`                                                                                                                            | Custom domain added to the egress ceiling (KOBE-38)                                                                                              |
| `egress.ceiling.changed`                     | install | `domain`, `inCeiling`                                                                                                               | A preset or custom domain put into or taken out of the ceiling                                                                                   |
| `egress.ceiling.removed`                     | install | `domain`                                                                                                                            | Custom domain deleted; every team's enablement of it went with it                                                                                |
| `egress.domain.enabled`                      | team    | `domain`                                                                                                                            | Team admin enabled a ceiling domain for the team's sandboxes                                                                                     |
| `egress.domain.disabled`                     | team    | `domain`                                                                                                                            | Team admin disabled it                                                                                                                           |
| `egress.connection`                          | team    | `userId`, `sandboxId`, `domain?`, `port?`, `outcome`, `reason?`, `aggregated?`, `connections`, `bytesUp`, `bytesDown`, `from`, `to` | Sandbox connections through the egress proxy, aggregated per key and window (system; see below)                                                  |
| `sandbox.created`                            | team    | `sandboxId`, `userId`                                                                                                               | A user's sandbox in a team was claimed (KOBE-22)                                                                                                 |
| `sandbox.destroyed`                          | team    | `sandboxId?`, `userId?`, `pod?`, `reason` (isolation_mismatch, isolation_lost)                                                      | The server deleted a sandbox or pod not running under the verified isolation runtime (KOBE-22)                                                   |
| `thread.trashed`                             | team    | `threadId`                                                                                                                          | Thread moved to Trash (D18 soft delete)                                                                                                          |
| `thread.restored`                            | team    | `threadId`                                                                                                                          | Thread restored from Trash                                                                                                                       |
| `thread.sharing_changed`                     | team    | `threadId`, `projectId`, `shared`                                                                                                   | Thread shared to or unshared from its project (D23)                                                                                              |
| `thread.agent_switched`                      | team    | `threadId`, `agentId`, `scope`, `fromVersion`, `toVersion`                                                                          | Thread pinned to another version of its agent (D19 one-click switch)                                                                             |
| `run.interrupted`                            | team    | `runId`, `threadId`, `cause` (sandbox_gone, not_resumed, pi_exited)                                                                 | The sandbox wire interrupted an active run (D14; system)                                                                                         |
| `run.cancelled`                              | team    | `runId`, `threadId`, `wasActive`, `queuePaused?`                                                                                    | The owner stopped a run or deleted a queued message (D17); `queuePaused: true` when the Stop paused the messages queued behind it (KOBE-26)      |
| `run.retried`                                | team    | `runId` (the new run), `threadId`, `retryOfRunId`                                                                                   | The owner retried an interrupted run (D14)                                                                                                       |
| `run.budget_stopped`                         | team    | `runId`, `threadId`, `scope` (install, team, user)                                                                                  | A run ended after its step because a budget is used up (D30; system)                                                                             |
| `sandbox.lease_violation`                    | team    | `sandboxId`, `userId`, `violation` (unknown_run, unknown_thread, unknown_command), `frameType`                                      | A sandbox named something not leased to it; connection closed (system; at most one per 5 minutes)                                                |
| `sandbox.limit_exceeded`                     | team    | `sandboxId`, `userId`, `limit` (frame_rate, byte_rate, frame_size, run_events, run_bytes, thread_entries), `runId?`                 | A sandbox exceeded a wire or storage limit; connection closed or run failed (system; throttled)                                                  |
| `sandbox.token_rejected`                     | team    | `sandboxId`, `userId`, `reason` (not_live, not_allowed, sandbox_mismatch)                                                           | A validly signed sandbox-wire token was refused (system; throttled)                                                                              |

**Never recorded:** passwords and password hashes, session, reset, invitation and approval tokens,
TOTP secrets and codes, backup codes, passkey material, cookies, API and provider keys, connector
credentials, injected headers, prompts, system prompts, agent definitions, message and thread
text, tool inputs and outputs, file contents, memory, artifact contents, and free-text error
messages. Failure reasons are error codes. A failed sign-in with an unknown email doesn't store
that email, because people sometimes type their password into the email field. Invitations are
recorded by invitation id, not the invitee's email (personal data in a log that can't be edited);
install invitations keep the email in `invitations`.

**Egress connections (KOBE-38).** The egress proxy writes `egress.connection` rows (system
actor) for every sandbox connection it handles, aggregated per (team, user, sandbox, host, port,
outcome, reason) over a 60-second window (`KOBE_EGRESS_AUDIT_FLUSH_MS`): each connection is
counted in exactly one row, with its bytes. Outcomes: `allowed`, `blocked` (`not_enabled`,
`not_in_ceiling`, `forbidden_address`, `sni_mismatch`, `invalid_target`, `port_not_allowed`,
`plain_http`, `connection_limit`, `inactive_member`) and `failed` (`dns_failure`, `upstream_unreachable`,
`policy_unavailable`). Requests without a valid session token have no team and are only logged by
the proxy. Each connection is also logged individually (JSON on stdout) for SIEM forwarding.
Each sandbox may add a limited number of distinct hosts per window (burst 32, then one every 2 s);
beyond that its connections are counted in one row with `aggregated: true` and no `domain`, so
a flood of random host names cannot flood the audit chain.

**Personal data still recorded:** user ids, team and agent names, and each request's client
address and user agent. Whether IP and user agent need a retention period (or pseudonymization)
in an append-only log is an open question for Chris (see the KOBE-15 ledger).

**Not recorded on purpose:** reads of the audit log; the normal `checking → verified` isolation
state at every replica start; and anything before first-run setup, so that an install about to be
restored stays empty. Better Auth's own writes (sign-in, credential changes) are recorded right
after the endpoint finishes, in a transaction of their own, because Better Auth owns those
transactions. A failure to record them is logged at error level and doesn't fail the request.
`kobe backup` is not recorded in the database, because the backup role is read-only. `kobe
restore` is recorded.

## Recording events (developers)

```ts
import { recordAudit } from "../audit/record.js"; // services/server

await withTeam(db, teamId, async (tx) => {
  // ... the action's writes ...
  await recordAudit(tx, {
    action: "identity.member.removed",
    teamId,
    target: { userId, role },
  });
});
```

- **Same transaction, last write.** Pass the action's transaction (`KobeTx`). `audit()` doesn't
  accept the pool. Append last, because the chain lock is held until commit.
- **Actor.** In a signed-in request the actor is the session user. Middleware sets it for the whole
  request (`auditUserContext`), so store functions don't pass it. Unauthenticated routes (Better
  Auth, setup) and code outside requests (jobs, the scheduler, the isolation gate) pass `actor`
  explicitly. Use `{ kind: "system", id: null }` (`SYSTEM_ACTOR`) for the platform, and
  `{ kind: "agent", id: agentId }` for an agent acting in a run. With no actor, the write throws and
  the action rolls back.
- **No transaction to join** (reads such as export, observations, Better Auth): use
  `recordAuditAfter(db, event)`. It never throws.
- **Anyone-can-trigger events** (unauthenticated attempts): go through `AuthAttemptAudit`
  (`deps.authAttempts`), which aggregates them per window. Never write one row per request for
  something an anonymous client controls.
- **Busy chain:** a write that can't get the chain lock throws `AuditBusyError`; the API maps it to
  503 `audit_busy`. Set your own `SET LOCAL lock_timeout` first if the action needs a shorter one.
- **New events:** add the action to `AUDIT_EVENTS` with the smallest target that identifies the
  object (ids, enums, counts, short labels), add it to the table above, and test it. Never rename or
  reuse a published action.

### What later tickets must record

These tickets are not on `main` yet. Each must call `recordAudit` in the transaction that performs
the action, adding its actions to `AUDIT_EVENTS`:

| Ticket                        | Actions to add (suggested names)                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KOBE-17 legal hold            | `governance.legal_hold.placed`, `.approved`, `.released` (`holdId`, `userId?`). Purges must check the hold.                                                                                                                                                                                                                                                                             |
| KOBE-18 retention             | `retention.policy.changed` (team: `period`); `retention.purged` (system, team scope, **counts only**: threads, entries, blobs); `thread.purged` for hard purges past Trash (`thread.trashed` / `thread.restored` exist).                                                                                                                                                                |
| KOBE-19 export / SIEM         | `audit.exported` (`from`, `to`, `format`, `rows`). Export pages with `listAuditEvents({ after })` (ascending keyset) and forwards `head` from `verifyAuditChain` as the anchor.                                                                                                                                                                                                         |
| KOBE-23/25/28 sandbox         | `sandbox.created` and `sandbox.destroyed` (isolation enforcement) exist (KOBE-22). Add `sandbox.hibernated`/`.woken` if wanted, offboarding destroy (`reason` value) and `sandbox.volume_purged` (`sandboxId`, `userId`). Never pod logs.                                                                                                                                               |
| KOBE-30/31 runs               | Done: `run.cancelled`, `run.retried`, `run.budget_stopped`; KOBE-24 records `run.interrupted`. Run starts are not audited: one per message, and every audit write serializes on the chain lock.                                                                                                                                                                                         |
| KOBE-33 search                | Nothing per query. Queries are content.                                                                                                                                                                                                                                                                                                                                                 |
| KOBE-36/37 approvals          | Rule CRUD and switches are recorded (`policy.*`). KOBE-37: `insertUserAllowRule` already records `policy.rule.created` (scope `user`) and requires an `actor`; call it in the approval's transaction; `approval.decided` (`approvalId`, `runId`, `toolCallId`, `tool`, `decision`, `remember`). **Tool calls**: `tool.called` with tool name, risk and decision, never input or output. |
| KOBE-38/39 egress             | KOBE-38 records the ceiling and enablement (`egress.ceiling.*`, `egress.domain.*`) and aggregated `egress.connection` rows from the proxy. KOBE-39: `egress.request.created`, `.decided`, `egress.header.set` (domain only, never the header value).                                                                                                                                    |
| KOBE-44/40 models and budgets | `models.catalog.changed`, `team.models.changed`, `budget.changed`, `budget.reached` (system).                                                                                                                                                                                                                                                                                           |
| KOBE-47 agents and skills     | (KOBE-46 recorded `agent.published`, `.rolled_back`, `.archived`, `.unarchived`, `thread.agent_switched`.) `skill.published`, `skill.reviewed` (`decision`), `skill.blocked` (`contentHash`).                                                                                                                                                                                           |
| KOBE-59–61 connectors         | `connector.registered`, `.pinned`, `.drift_approved`, `team.connector.enabled`, `connector.grant.connected`, `.revoked` (never credentials).                                                                                                                                                                                                                                            |
| KOBE-64 schedules             | `schedule.created`, `.paused`, `.deleted` (`scheduleId`, `agentId`).                                                                                                                                                                                                                                                                                                                    |

## Reading the log

| Endpoint                          | Who                                 | Notes                                                                                                                                                                                |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/install/audit`           | Owner, Admin (`install.audit.read`) | Filters: `action`, `category` (agent, auth, governance, identity, install, platform, policy, run, sandbox, thread), `actorId`, `teamId`, `since`, `until` (ISO). `limit` 1–200 (50). |
| `GET /v1/team/audit`              | Team admin (`team.audit.read`)      | Same filters except `teamId`; only the active team's events; no `ip`, `userAgent`, `prevHash` or `hash`.                                                                             |
| `GET /v1/install/audit/integrity` | Owner, Admin (3 per minute)         | `{ ok, checked, head: { seq, hash }, problem?, anchor: { seq, hash, at, mac } }`: a full-chain check plus the attested head                                                          |

Pages are newest first: pass `nextCursor` back as `before`. Pass `after` (for example `after=0`)
to page oldest first, as an export does. Unknown parameters return 400.

## Anchoring the chain

The chain is unkeyed: whoever can rewrite rows (a superuser, or the owner after disabling the
triggers) can recompute every hash after them. What they can't change is a head already copied
somewhere else, so Kobe makes copies:

- **Server log.** Every server replica logs `audit chain head` with `auditHead: { seq, hash, at,
mac }` at startup and every 5 minutes (all replicas; the lines are the same apart from `at`).
  Before each line it verifies the rows appended since its previous head and that the previous head
  is unchanged; a break is logged at error level as `audit chain verification failed`. **Ship the
  server log off the cluster** (log collector) and alert on that error. SIEM forwarding (KOBE-19)
  will carry the same anchors.
- **MAC.** `mac` is HMAC-SHA256 over `seq:hash` under a key derived from the auth secret (a
  Kubernetes Secret, never in the database), so a database-only attacker can't mint an anchor for
  a head they invented. Verify one with `anchorMac(anchorKey(authSecret), seq, hash)`.
- **Backups.** The signed backup manifest records the snapshot's head, and `kobe restore` requires
  the restored chain to end there. `--expect-audit-head <seq>:<hash>` additionally requires a head
  you recorded earlier (from the log or a SIEM) to be in the restored chain.

**Decision: no keyed hash in the database.** Making each row's hash an HMAC would mean the key
enters the database session on every insert (where the owner role and statement logs can see it),
or a SECURITY DEFINER path, which Kobe doesn't allow. Attesting heads in the server, with a key the
database never sees, gives the same protection for anchored heads at no per-row cost.

## Operations

- **Integrity:** ship the server log's `audit chain head` lines off the box and alert on `audit
chain verification failed`. `GET /v1/install/audit/integrity` runs a full check on demand and
  returns the attested head.
- **Backup:** `audit_log` is backed up like every table, and the restore loads its rows verbatim
  (`seq` and hashes included) with triggers disabled for the load only. It then appends
  `platform.restore.completed` in the same transaction, after the triggers are back, so the chain
  continues. Before that, still inside the transaction, it **verifies the whole restored chain**
  (gaps, `prev_hash` links, every row's hash), checks that it ends at the head the signed manifest
  recorded and, with `--expect-audit-head`, that it contains the head you recorded. Any problem
  rolls the whole restore back. The restore event records the operator (`--operator`, default the
  OS user) and the restored head, and the CLI prints the final head: record it. The append-only
  triggers and grants are the release's own (restore never touches schema or grants).
- **Restore into a fresh install:** a restore refuses a database that already has audit rows.
  Before first-run setup, Kobe records only failed sign-ins (for example a scanner trying
  `/api/auth/sign-in/email`). If the restore reports `audit_log` as non-empty, reinstall the target
  database and scale the server down before anyone can reach it.
- **Retention:** v1 keeps the audit log forever. Nothing in the app can delete from it. Pruning
  would be a migration-owner operation, documented with it, and the chain would then be verified
  from an anchored `(seq, prev_hash)` (`verifyAuditChain({ fromSeq, expectedPrevHash })`).
