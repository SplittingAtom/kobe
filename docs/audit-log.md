# Audit log

Kobe keeps one install-wide, append-only audit log in Postgres (spec D6, D31; KOBE-15). Install
admins (Owner, Admin) read all of it; team admins read their team's events. Each event records
metadata only: who did what, to which object, when, and from where. Secrets, tokens, passwords,
prompts and message text are never recorded.

## What is guaranteed

| Property                  | How                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Action and event agree    | `audit()` takes the transaction that performs the action. Both commit or both roll back. An invalid event (unknown action, a field outside the allowlist, wrong team scope, no actor) throws, so the action fails as well.                                                |
| Append-only for the app   | The app role holds `INSERT` and `SELECT` on `audit_log`, nothing else (tenancy registry, applied by the migration runner). `UPDATE`, `DELETE` and `TRUNCATE` fail with `permission denied`.                                                                               |
| Append-only for the owner | Triggers refuse `UPDATE`, `DELETE` and `TRUNCATE` for every role they fire for, including the schema owner.                                                                                                                                                               |
| Tampering is detectable   | Every row carries `seq` (gapless from 1), `prev_hash` and `hash = sha256(audit_log_canonical(row))`, where the canonical text includes `prev_hash`. The `BEFORE INSERT` trigger assigns them under a transaction-scoped advisory lock, so the chain follows commit order. |
| Team events stay in team  | Inside `withTeam()`, an event can only be recorded for the active team (or for no team). The trigger enforces this.                                                                                                                                                       |

A superuser, or the owner after it drops the triggers, can still change rows. The chain makes that
visible. `verifyAuditChain()` (or `GET /v1/install/audit/integrity`) recomputes every hash and
reports the first row that was edited (`hash_mismatch`), removed (`gap`) or re-chained
(`prev_hash_mismatch`). The chain can't reveal two things on its own: a rewrite of every row from
some point onwards, and the removal of the newest rows. To catch those, compare the reported `head`
(`seq`, `hash`) with a copy kept outside the database. Audit export and SIEM forwarding (KOBE-19)
are the intended places to keep that copy.

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
| `target`            | jsonb       | The action's allowlisted fields (below); ≤ 4 KB                                                      |
| `ip`                | inet / null | Client address of the request (X-Forwarded-For via the trusted proxies, as for rate limits)          |
| `user_agent`        | text / null | Client user agent, control characters removed, ≤ 256 characters                                      |
| `prev_hash`, `hash` | hex text    | The hash chain                                                                                       |

The read APIs also return the actor's current name and email when the actor is a user. Users are
never deleted.

## Team scoping

`audit_log` is install-wide (§5.4 marks it †) and has a nullable `team_id` column. It has no RLS.
The team view is `listTeamAuditEvents(db, teamId, query)`. That function always filters on
`team_id` and ignores any `teamId` in the query. It is the only way the team route reads the log.
The alternative, a separate team table behind RLS, was rejected for three reasons:

- An event about a team is often an install-level act. Team creation, break-glass and legal hold
  are done by install admins. Install admins need these events in their log, and team admins need
  them in theirs. A second table would mean writing every such event twice, in two chains.
- Team RLS would hide team events from the install log. Install admins don't run inside a team
  context.
- The table holds no team content, only allowlisted metadata. So a missed filter would show
  metadata, not threads.

The team view also leaves out `ip` and `user_agent`, because they are personal data of install
admins and other members. Every team-scoped action requires `teamId` (enforced by `audit()`).

## Event taxonomy and field allowlist

The source of truth is `AUDIT_EVENTS` in `packages/db/src/audit/events.ts`. Each target is a
strict zod object, and unknown keys are rejected. A unit test fails if an action is missing from
this page, or if a field name suggests content or credentials. Scope `install` means no team.
Scope `team` means the team view shows the event. Scope `any` means team for team agents and
install for personal and gallery agents.

| Action                                     | Scope   | Target fields (allowlist)                                                                       | Recorded when                                                               |
| ------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `auth.sign_in.succeeded`                   | install | `method` (password, totp, backup_code, passkey, invitation)                                     | A session is created                                                        |
| `auth.sign_in.failed`                      | install | `method`, `reason` (error code), `userId?`                                                      | A sign-in step fails; `userId` only if the email names an account           |
| `auth.sign_in.two_factor_required`         | install | `method`                                                                                        | Password accepted, TOTP still outstanding                                   |
| `auth.sign_out`                            | install | —                                                                                               | Sign-out                                                                    |
| `auth.session.revoked`                     | install | `which` (one, others, all)                                                                      | The user revokes sessions                                                   |
| `auth.password.changed`                    | install | —                                                                                               | Password change                                                             |
| `auth.password.reset_requested`            | install | `userId`                                                                                        | Reset requested for an existing, active account (actor null)                |
| `auth.password.reset`                      | install | `userId`                                                                                        | Reset completed                                                             |
| `auth.two_factor.enabled`                  | install | —                                                                                               | TOTP enrollment verified                                                    |
| `auth.two_factor.disabled`                 | install | —                                                                                               | 2FA turned off                                                              |
| `auth.two_factor.backup_codes_regenerated` | install | —                                                                                               | New backup codes                                                            |
| `auth.passkey.added`                       | install | —                                                                                               | Passkey registered                                                          |
| `auth.passkey.removed`                     | install | `passkeyId?`                                                                                    | Passkey deleted                                                             |
| `identity.setup.completed`                 | install | `ownerUserId`                                                                                   | First-run setup created the Owner                                           |
| `identity.invitation.created`              | install | `invitationId`, `email`                                                                         | Install invitation sent                                                     |
| `identity.invitation.resent`               | install | `invitationId`, `email`                                                                         | Re-sent (new token)                                                         |
| `identity.invitation.revoked`              | install | `invitationId`                                                                                  | Revoked                                                                     |
| `identity.invitation.accepted`             | install | `invitationId`, `userId`                                                                        | Account created from it (actor: the new user)                               |
| `identity.user.deactivated`                | install | `userId`                                                                                        | Deactivation                                                                |
| `identity.user.reactivated`                | install | `userId`                                                                                        | Reactivation                                                                |
| `identity.install_role.granted`            | install | `userId`, `role` (admin)                                                                        | Admin granted                                                               |
| `identity.install_role.revoked`            | install | `userId`, `role` (admin)                                                                        | Admin revoked                                                               |
| `identity.ownership.transferred`           | install | `fromUserId`, `toUserId`                                                                        | Ownership transfer                                                          |
| `identity.team.created`                    | team    | `slug`, `name`, `adminUserId`                                                                   | Team created with its first team admin                                      |
| `identity.team.renamed`                    | team    | `name`                                                                                          | Team renamed                                                                |
| `identity.team_invitation.created`         | team    | `invitationId`, `email`, `role`                                                                 | Team invitation sent or renewed                                             |
| `identity.team_invitation.revoked`         | team    | `invitationId`                                                                                  | Revoked by a team admin                                                     |
| `identity.team_invitation.accepted`        | team    | `userId`, `role`, `invitedBy`                                                                   | Invitee joined (actor: the invitee)                                         |
| `identity.team_invitation.declined`        | team    | —                                                                                               | Invitee declined (actor: the invitee)                                       |
| `identity.member.role_changed`             | team    | `userId`, `from`, `to`                                                                          | Team role changed                                                           |
| `identity.member.removed`                  | team    | `userId`, `role`                                                                                | Member removed                                                              |
| `install.settings.updated`                 | install | `setting` (require_two_factor), `value`                                                         | Install setting changed                                                     |
| `platform.isolation.changed`               | install | `from`, `to`, `runtimeClass?`, `handler?`, `replica`                                            | A server replica lost or regained isolation, or started without it (system) |
| `platform.restore.completed`               | install | `backupCreatedAt`, `tables`, `rows`                                                             | `kobe restore` loaded a backup (system, same transaction)                   |
| `agent.created`                            | any     | `agentId`, `scope`, `slug`, `source` (json, import, fork), `forkedFrom?`                        | Agent created, imported from a file, or forked                              |
| `agent.updated`                            | any     | `agentId`, `scope`, `slug`, `revision`, `source` (json, import)                                 | Draft replaced                                                              |
| `agent.deleted`                            | any     | `agentId`, `scope`, `slug`                                                                      | Agent deleted                                                               |
| `agent.status_changed`                     | any     | `agentId`, `scope`, `slug`, `status`                                                            | Suspended or reactivated                                                    |
| `agent.exported`                           | any     | `agentId`, `scope`, `slug`                                                                      | Agent file downloaded                                                       |
| `policy.rule.created`                      | any     | `ruleId`, `scope` (install, team, user), `effect`, `toolGlob`, `argPatternEntries`, `expiresAt` | Tool rule created (install floor: install; team and user rules: team)       |
| `policy.rule.updated`                      | any     | as `policy.rule.created`                                                                        | Tool rule replaced                                                          |
| `policy.rule.deleted`                      | any     | as `policy.rule.created`                                                                        | Tool rule deleted, including a member revoking their own remember-rule      |
| `policy.settings.updated`                  | install | `setting` (prompt_sandbox_writes), `value`                                                      | Install policy switch changed                                               |
| `thread.trashed`                           | team    | `threadId`                                                                                      | Thread moved to Trash (D18 soft delete)                                     |
| `thread.restored`                          | team    | `threadId`                                                                                      | Thread restored from Trash                                                  |
| `thread.sharing_changed`                   | team    | `threadId`, `projectId`, `shared`                                                               | Thread shared to or unshared from its project (D23)                         |

**Never recorded:** passwords and password hashes, session, reset, invitation and approval tokens,
TOTP secrets and codes, backup codes, passkey material, cookies, API and provider keys, connector
credentials, injected headers, prompts, system prompts, agent definitions, message and thread
text, tool inputs and outputs, file contents, memory, artifact contents, and free-text error
messages. Failure reasons are error codes. A failed sign-in with an unknown email doesn't store
that email, because people sometimes type their password into the email field.

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
- **New events:** add the action to `AUDIT_EVENTS` with the smallest target that identifies the
  object (ids, enums, counts, short labels), add it to the table above, and test it. Never rename or
  reuse a published action.

### What later tickets must record

These tickets are not on `main` yet. Each must call `recordAudit` in the transaction that performs
the action, adding its actions to `AUDIT_EVENTS`:

| Ticket                        | Actions to add (suggested names)                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KOBE-16 break-glass           | `governance.break_glass.requested`, `.approved`, `.denied`, `.expired`, `.revoked` (team scope; `grantId`, `subjectUserId?`, `threadId?`, `legalHold`, `expiresAt`, `selfApproved`); `governance.break_glass.read` for **every read** during the window (team scope; object ids only). The team view's banner can query the active grant. Notifications go to team admins. |
| KOBE-17 legal hold            | `governance.legal_hold.placed`, `.approved`, `.released` (`holdId`, `userId?`). Purges must check the hold.                                                                                                                                                                                                                                                                |
| KOBE-18 retention             | `retention.policy.changed` (team: `period`); `retention.purged` (system, team scope, **counts only**: threads, entries, blobs); `thread.purged` for hard purges past Trash (`thread.trashed` / `thread.restored` exist).                                                                                                                                                   |
| KOBE-19 export / SIEM         | `audit.exported` (`from`, `to`, `format`, `rows`). Export pages with `listAuditEvents({ after })` (ascending keyset) and forwards `head` from `verifyAuditChain` as the anchor.                                                                                                                                                                                            |
| KOBE-22/23/28 sandbox         | `sandbox.created`, `sandbox.destroyed`, `sandbox.volume_purged` (system or user; `sandboxId`, `userId`). Never pod logs.                                                                                                                                                                                                                                                   |
| KOBE-30/31 runs               | No per-message events. Record run start, stop and interruption only as metadata (`runId`, `threadId`, `agentId`, `status`).                                                                                                                                                                                                                                                |
| KOBE-33 search                | Nothing per query. Queries are content.                                                                                                                                                                                                                                                                                                                                    |
| KOBE-36/37 approvals          | Rule CRUD and switches are recorded (`policy.*`). KOBE-37: remember-rules created by an approval → `policy.rule.created` (scope `user`) in the approval's transaction; `approval.decided` (`approvalId`, `runId`, `toolCallId`, `tool`, `decision`, `remember`). **Tool calls**: `tool.called` with tool name, risk and decision, never input or output.                   |
| KOBE-38/39 egress             | `egress.connection` (team: domain, bytes, user; system actor from the proxy). High volume: consider batching per connection close. `egress.domain.enabled`, `.disabled`, `egress.request.created`, `.decided`, `egress.header.set` (domain only, never the header value).                                                                                                  |
| KOBE-44/40 models and budgets | `models.catalog.changed`, `team.models.changed`, `budget.changed`, `budget.reached` (system).                                                                                                                                                                                                                                                                              |
| KOBE-46/47 agents and skills  | `agent.published` (`version`), `skill.published`, `skill.reviewed` (`decision`), `skill.blocked` (`contentHash`).                                                                                                                                                                                                                                                          |
| KOBE-59–61 connectors         | `connector.registered`, `.pinned`, `.drift_approved`, `team.connector.enabled`, `connector.grant.connected`, `.revoked` (never credentials).                                                                                                                                                                                                                               |
| KOBE-64 schedules             | `schedule.created`, `.paused`, `.deleted` (`scheduleId`, `agentId`).                                                                                                                                                                                                                                                                                                       |

## Reading the log

| Endpoint                          | Who                                 | Notes                                                                                                                                                      |
| --------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/install/audit`           | Owner, Admin (`install.audit.read`) | Filters: `action`, `category` (agent, auth, identity, install, platform, policy, thread), `actorId`, `teamId`, `since`, `until` (ISO). `limit` 1–200 (50). |
| `GET /v1/team/audit`              | Team admin (`team.audit.read`)      | Same filters except `teamId`; only the active team's events; no `ip` or `userAgent`.                                                                       |
| `GET /v1/install/audit/integrity` | Owner, Admin                        | `{ ok, checked, head: { seq, hash }, problem? }`                                                                                                           |

Pages are newest first: pass `nextCursor` back as `before`. Pass `after` (for example `after=0`)
to page oldest first, as an export does. Unknown parameters return 400.

## Operations

- **Integrity:** call `GET /v1/install/audit/integrity` periodically and record `head` somewhere
  else. Once KOBE-19 lands, a SIEM keeps that copy.
- **Backup:** `audit_log` is backed up like every table, and the restore loads its rows verbatim
  (`seq` and hashes included) with triggers disabled for the load only. It then appends
  `platform.restore.completed` in the same transaction, after the triggers are back, so the chain
  continues. The append-only triggers and grants are the release's own (restore never touches
  schema or grants).
- **Restore into a fresh install:** a restore refuses a database that already has audit rows.
  Before first-run setup, Kobe records only failed sign-ins (for example a scanner trying
  `/api/auth/sign-in/email`). If the restore reports `audit_log` as non-empty, reinstall the target
  database and scale the server down before anyone can reach it.
- **Retention:** v1 keeps the audit log forever. Nothing in the app can delete from it. Pruning
  would be a migration-owner operation, documented with it, and the chain would then be verified
  from an anchored `(seq, prev_hash)` (`verifyAuditChain({ fromSeq, expectedPrevHash })`).
