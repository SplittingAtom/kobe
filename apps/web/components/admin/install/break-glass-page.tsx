"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  decideGrant,
  listGrants,
  requestGrant,
  type BreakGlassGrant,
  type GrantDecision,
  type GrantList,
  type GrantScope,
} from "../../../lib/admin/api/install/break-glass";
import {
  listInstallTeams,
  teamRoster,
  type InstallTeam,
  type RosterMember,
} from "../../../lib/admin/api/install/teams";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { BreakGlassReader } from "./break-glass-reader";
import styles from "../admin.module.css";

interface PageData extends GrantList {
  readonly teams: readonly InstallTeam[];
}

async function loadPage(): Promise<ApiResult<PageData>> {
  const [grants, teams] = await Promise.all([listGrants(), listInstallTeams()]);
  if (!grants.ok) return grants;
  if (!teams.ok) return teams;
  return { ok: true, status: 200, data: { ...grants.data, teams: teams.data } };
}

const DURATIONS = [15, 30, 60, 120, 240, 480, 1440] as const;

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

const STATUS_LABELS = {
  pending: "Waiting for approval",
  active: "Active",
  denied: "Denied",
  revoked: "Revoked",
  expired: "Ended",
} as const;

export function scopeLabel(grant: Pick<BreakGlassGrant, "scope" | "subject" | "threadId">): string {
  if (grant.scope === "user") return `Threads of ${grant.subject?.name ?? "one user"}`;
  if (grant.scope === "thread") return `Thread ${grant.threadId ?? ""}`;
  return "Whole team";
}

/**
 * Break-glass (spec D10; `/v1/install/break-glass`). An install admin asks for time-boxed,
 * read-only access to one team (optionally one user or one thread) with a reason; a second install
 * admin approves (a single-admin install self-approves, flagged). The team's admins are notified,
 * and every read is recorded in the team's audit log. The server and the database decide.
 */
export function BreakGlassPage() {
  const { state, reload } = useResource(loadPage);
  const mutation = useMutation();
  const [reading, setReading] = useState<BreakGlassGrant | null>(null);

  async function decide(grant: BreakGlassGrant, decision: GrantDecision) {
    const verbs = {
      approve: "Approve",
      deny: "Deny",
      revoke: grant.status === "pending" ? "Withdraw" : "Revoke",
    };
    if (!confirmed(`${verbs[decision]} break-glass access to ${grant.team.name}?`)) return;
    const done = await mutation.run(
      () => decideGrant(grant.id, decision),
      (g) => `${STATUS_LABELS[g.status]}: ${g.team.name}.`,
    );
    if (done) {
      if (reading?.id === grant.id) setReading(null);
      reload();
    }
  }

  if (reading) {
    return (
      <BreakGlassReader
        grant={reading}
        onClose={() => {
          setReading(null);
          reload();
        }}
      />
    );
  }

  return (
    <>
      <h1>Break-glass</h1>
      <p className={styles.hint}>
        Install admins can&apos;t read team content. Break-glass gives one install admin read-only
        access to one team for a limited time, after a second install admin approves. The
        team&apos;s admins are notified, and every read is recorded in the team&apos;s audit log.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="break-glass grants">
        {(data) => (
          <>
            <RequestForm
              teams={data.teams}
              soleAdmin={data.selfApprovalAllowed}
              mutation={mutation}
              onRequested={reload}
            />
            <GrantTable
              grants={data.grants}
              onDecide={decide}
              onRead={setReading}
              pending={mutation.pending}
            />
          </>
        )}
      </ResourceView>
    </>
  );
}

type Mutation = ReturnType<typeof useMutation>;

function RequestForm({
  teams,
  soleAdmin,
  mutation,
  onRequested,
}: {
  readonly teams: readonly InstallTeam[];
  readonly soleAdmin: boolean;
  readonly mutation: Mutation;
  readonly onRequested: () => void;
}) {
  const [teamId, setTeamId] = useState("");
  const [scope, setScope] = useState<GrantScope>("team");
  const [userId, setUserId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState(60);
  const [legalHold, setLegalHold] = useState(false);
  const [roster, setRoster] = useState<readonly RosterMember[]>([]);

  async function chooseTeam(id: string) {
    setTeamId(id);
    setUserId("");
    setRoster([]);
    if (!id) return;
    const res = await teamRoster(id);
    if (res.ok) setRoster(res.data);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () =>
        requestGrant({
          teamId,
          reason: reason.trim(),
          durationMinutes: duration,
          legalHold,
          userId: scope === "user" ? userId : undefined,
          threadId: scope === "thread" ? threadId.trim() : undefined,
        }),
      (g) =>
        soleAdmin
          ? `Requested access to ${g.team.name}. You are the only install admin: you can approve it yourself (it will be flagged).`
          : `Requested access to ${g.team.name}. A second install admin must approve it.`,
    );
    if (done) {
      setReason("");
      setScope("team");
      setUserId("");
      setThreadId("");
      setLegalHold(false);
      onRequested();
    }
  }

  return (
    <>
      <h2>Request access</h2>
      <form onSubmit={onSubmit} className={styles.form} aria-label="Request break-glass access">
        <label>
          Team
          <select required value={teamId} onChange={(e) => void chooseTeam(e.target.value)}>
            <option value="">Choose a team…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Scope</legend>
          {(["team", "user", "thread"] as const).map((s) => (
            <label key={s}>
              <input
                type="radio"
                name="scope"
                value={s}
                checked={scope === s}
                onChange={() => setScope(s)}
              />
              {s === "team" ? "Whole team" : s === "user" ? "One user's threads" : "One thread"}
            </label>
          ))}
        </fieldset>
        {scope === "user" && (
          <label>
            User
            <select required value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose a member…</option>
              {roster.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} ({m.email})
                </option>
              ))}
            </select>
          </label>
        )}
        {scope === "thread" && (
          <label>
            Thread id
            <input required value={threadId} onChange={(e) => setThreadId(e.target.value)} />
          </label>
        )}
        <label>
          Duration
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {durationLabel(d)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reason
          <textarea
            required
            minLength={10}
            maxLength={2000}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={legalHold}
            onChange={(e) => setLegalHold(e.target.checked)}
          />
          Legal hold (don&apos;t notify the user being investigated)
        </label>
        <button type="submit" disabled={mutation.pending}>
          Request access
        </button>
      </form>
      {soleAdmin && (
        <p className={styles.hint}>
          You are this install&apos;s only active admin, so you can approve your own request. The
          grant is flagged as self-approved everywhere it appears.
        </p>
      )}
    </>
  );
}

function GrantTable({
  grants,
  onDecide,
  onRead,
  pending,
}: {
  readonly grants: readonly BreakGlassGrant[];
  readonly onDecide: (grant: BreakGlassGrant, decision: GrantDecision) => void;
  readonly onRead: (grant: BreakGlassGrant) => void;
  readonly pending: boolean;
}) {
  if (grants.length === 0) return <p>No break-glass requests yet.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption>Requests and grants</caption>
        <thead>
          <tr>
            <th scope="col">Team</th>
            <th scope="col">Requested by</th>
            <th scope="col">Scope</th>
            <th scope="col">Reason</th>
            <th scope="col">Status</th>
            <th scope="col">Window</th>
            <th scope="col">
              <span className={styles.visuallyHidden}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {grants.map((g) => (
            <tr key={g.id}>
              <td>{g.team.name}</td>
              <td>
                {g.requestedBy.name}
                <br />
                <DateTime value={g.requestedAt} />
              </td>
              <td>
                {scopeLabel(g)}
                {g.legalHold && <> · legal hold</>}
              </td>
              <td>{g.reason}</td>
              <td>
                {STATUS_LABELS[g.status]}
                {g.approvedBy && (
                  <>
                    <br />
                    {g.selfApproved
                      ? `Self-approved by ${g.approvedBy.name} (flagged)`
                      : `Approved by ${g.approvedBy.name}`}
                  </>
                )}
              </td>
              <td>
                {g.startsAt ? (
                  <>
                    <DateTime value={g.startsAt} /> – <DateTime value={g.endedAt ?? g.expiresAt} />
                  </>
                ) : (
                  durationLabel(g.durationMinutes)
                )}
              </td>
              <td>
                <div className={styles.actions}>
                  {g.actions.read && (
                    <button type="button" onClick={() => onRead(g)}>
                      Read
                    </button>
                  )}
                  {g.actions.approve && (
                    <button type="button" disabled={pending} onClick={() => onDecide(g, "approve")}>
                      Approve
                    </button>
                  )}
                  {g.actions.deny && (
                    <button type="button" disabled={pending} onClick={() => onDecide(g, "deny")}>
                      Deny
                    </button>
                  )}
                  {g.actions.revoke && (
                    <button type="button" disabled={pending} onClick={() => onDecide(g, "revoke")}>
                      {g.status === "pending" ? "Withdraw" : "Revoke"}
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
