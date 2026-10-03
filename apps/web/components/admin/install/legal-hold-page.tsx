"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  decideHold,
  listHolds,
  requestHold,
  requestRelease,
  type HoldDecision,
  type HoldList,
  type HoldScope,
  type LegalHold,
} from "../../../lib/admin/api/install/legal-hold";
import {
  listInstallTeams,
  teamRoster,
  type InstallTeam,
  type RosterMember,
} from "../../../lib/admin/api/install/teams";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";
import styles from "../admin.module.css";

interface PageData extends HoldList {
  readonly teams: readonly InstallTeam[];
}

async function loadPage(): Promise<ApiResult<PageData>> {
  const [holds, teams] = await Promise.all([listHolds(), listInstallTeams()]);
  if (!holds.ok) return holds;
  if (!teams.ok) return teams;
  return { ok: true, status: 200, data: { ...holds.data, teams: teams.data } };
}

const STATUS_LABELS = {
  pending: "Waiting for approval",
  active: "In force",
  denied: "Denied",
  withdrawn: "Withdrawn",
  released: "Released",
} as const;

const DECISIONS: Record<HoldDecision, { readonly verb: string; readonly done: string }> = {
  approve: { verb: "Place", done: "The hold is in force: purges of this data are suspended." },
  deny: { verb: "Deny", done: "Request denied." },
  withdraw: { verb: "Withdraw", done: "Request withdrawn." },
  "release/approve": { verb: "Release", done: "Released: purges of this data may resume." },
  "release/deny": { verb: "Deny the release of", done: "Release denied: the hold stays in force." },
  "release/withdraw": {
    verb: "Withdraw the release of",
    done: "Release request withdrawn: the hold stays in force.",
  },
};

export function holdScopeLabel(hold: Pick<LegalHold, "scope" | "subject">): string {
  return hold.scope === "user" ? `Data of ${hold.subject?.name ?? "one user"}` : "Whole team";
}

/**
 * Legal hold (spec D18; `/v1/install/legal-hold`). An install admin asks to hold a team's data, or
 * one user's data in a team, with a reason; a second install admin places it (a single-admin
 * install self-approves, flagged). While in force, retention and Trash purges, offboarding volume
 * deletion and the audit log's IP erasure skip that data. Releasing needs a second admin too.
 * Holds are confidential: the held user never sees them, and team admins aren't told.
 */
export function LegalHoldPage() {
  const { state, reload } = useResource(loadPage);
  const mutation = useMutation();
  const [releasing, setReleasing] = useState<LegalHold | null>(null);

  async function decide(hold: LegalHold, decision: HoldDecision) {
    const { verb, done } = DECISIONS[decision];
    if (!confirmed(`${verb} the legal hold on ${hold.team.name} (${holdScopeLabel(hold)})?`)) {
      return;
    }
    if (
      await mutation.run(
        () => decideHold(hold.id, decision),
        () => done,
      )
    )
      reload();
  }

  return (
    <>
      <h1>Legal hold</h1>
      <p className={styles.hint}>
        A legal hold suspends every purge of a team&apos;s data, or of one user&apos;s data in a
        team: retention and Trash purges, deletion of an offboarded member&apos;s workspace, and the
        erasure of IP addresses from the audit log. Placing and releasing a hold each need a second
        install admin. The person held is not told, and can&apos;t see the hold.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="legal holds">
        {(data) => (
          <>
            <RequestForm
              teams={data.teams}
              soleAdmin={data.selfApprovalAllowed}
              mutation={mutation}
              onRequested={reload}
            />
            {releasing && (
              <ReleaseForm
                hold={releasing}
                mutation={mutation}
                onDone={() => {
                  setReleasing(null);
                  reload();
                }}
                onCancel={() => setReleasing(null)}
              />
            )}
            <HoldTable
              holds={data.holds}
              pending={mutation.pending}
              onDecide={decide}
              onRelease={setReleasing}
            />
          </>
        )}
      </ResourceView>
    </>
  );
}

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
  const [scope, setScope] = useState<HoldScope>("team");
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
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
        requestHold({
          teamId,
          reason: reason.trim(),
          userId: scope === "user" ? userId : undefined,
        }),
      ({ hold }) =>
        soleAdmin
          ? `Requested a hold on ${hold.team.name}. You are the only install admin: you can place it yourself (it will be flagged).`
          : `Requested a hold on ${hold.team.name}. A second install admin must place it.`,
    );
    if (done) {
      setReason("");
      setScope("team");
      setUserId("");
      onRequested();
    }
  }

  return (
    <>
      <h2>Request a hold</h2>
      <form onSubmit={onSubmit} className={styles.form} aria-label="Request a legal hold">
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
          {(["team", "user"] as const).map((s) => (
            <label key={s}>
              <input
                type="radio"
                name="scope"
                value={s}
                checked={scope === s}
                onChange={() => setScope(s)}
              />
              {s === "team" ? "Whole team" : "One user's data in this team"}
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
        <button type="submit" disabled={mutation.pending}>
          Request hold
        </button>
      </form>
      {soleAdmin && (
        <p className={styles.hint}>
          You are this install&apos;s only active admin, so you can place and release holds you
          asked for yourself. They are flagged as self-approved.
        </p>
      )}
    </>
  );
}

function ReleaseForm({
  hold,
  mutation,
  onDone,
  onCancel,
}: {
  readonly hold: LegalHold;
  readonly mutation: Mutation;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => requestRelease(hold.id, reason.trim()),
      () => "Release requested. The hold stays in force until a second install admin approves.",
    );
    if (done) onDone();
  }

  return (
    <form onSubmit={onSubmit} className={styles.form} aria-label="Ask to release a legal hold">
      <h2>
        Release the hold on {hold.team.name} ({holdScopeLabel(hold)})
      </h2>
      <label>
        Why can it end?
        <textarea
          required
          minLength={10}
          maxLength={2000}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <div className={styles.actions}>
        <button type="submit" disabled={mutation.pending}>
          Ask to release
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function approval(name: string, self: boolean, what: string): string {
  return self ? `${what} by ${name} alone (self-approved, flagged)` : `${what} by ${name}`;
}

function HoldStatus({ hold }: { readonly hold: LegalHold }) {
  return (
    <>
      {STATUS_LABELS[hold.status]}
      {hold.approvedBy && (
        <>
          <br />
          {approval(hold.approvedBy.name, hold.selfApproved, "Placed")}
        </>
      )}
      {hold.closedBy && (
        <>
          <br />
          {hold.status === "withdrawn" ? "Withdrawn" : "Denied"} by {hold.closedBy.name}
        </>
      )}
      {hold.release && (
        <>
          <br />
          <strong>Release requested</strong> by {hold.release.requestedBy?.name ?? "an admin"}:{" "}
          {hold.release.reason}
        </>
      )}
      {hold.releasedBy && (
        <>
          <br />
          {approval(hold.releasedBy.name, hold.releaseSelfApproved, "Released")}{" "}
          <DateTime value={hold.releasedAt} />
        </>
      )}
    </>
  );
}

const BUTTONS: readonly [keyof LegalHold["actions"], HoldDecision | "release", string][] = [
  ["approve", "approve", "Place"],
  ["deny", "deny", "Deny"],
  ["withdraw", "withdraw", "Withdraw"],
  ["requestRelease", "release", "Ask to release"],
  ["approveRelease", "release/approve", "Approve release"],
  ["denyRelease", "release/deny", "Deny release"],
  ["withdrawRelease", "release/withdraw", "Withdraw release"],
];

function HoldTable({
  holds,
  pending,
  onDecide,
  onRelease,
}: {
  readonly holds: readonly LegalHold[];
  readonly pending: boolean;
  readonly onDecide: (hold: LegalHold, decision: HoldDecision) => void;
  readonly onRelease: (hold: LegalHold) => void;
}) {
  if (holds.length === 0) return <p>No legal holds yet.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption>Holds and requests</caption>
        <thead>
          <tr>
            <th scope="col">Team</th>
            <th scope="col">Scope</th>
            <th scope="col">Requested by</th>
            <th scope="col">Reason</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className={styles.visuallyHidden}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {holds.map((hold) => (
            <tr key={hold.id}>
              <td>{hold.team.name}</td>
              <td>{holdScopeLabel(hold)}</td>
              <td>
                {hold.requestedBy.name}
                <br />
                <DateTime value={hold.requestedAt} />
              </td>
              <td>{hold.reason}</td>
              <td>
                <HoldStatus hold={hold} />
              </td>
              <td>
                <div className={styles.actions}>
                  {BUTTONS.filter(([allowed]) => hold.actions[allowed]).map(
                    ([allowed, decision, label]) => (
                      <button
                        key={allowed}
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          decision === "release" ? onRelease(hold) : onDecide(hold, decision)
                        }
                      >
                        {label}
                      </button>
                    ),
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
