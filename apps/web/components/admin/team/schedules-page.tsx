"use client";

import { useMemo } from "react";
import { listTeamMembers, type TeamMember } from "../../../lib/admin/api/team/members";
import { createSchedulesApi, type Schedule } from "../../../lib/schedules/api";
import { describeRecurrence, formatInZone } from "../../../lib/schedules/format";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

function statusOf(s: Schedule): string {
  if (s.active) return "Active";
  if (s.pausedBy === "team_admin") return "Paused by a team admin";
  if (s.pausedBy === "deactivation") return "Paused: owner deactivated or removed";
  return "Paused by its owner";
}

/** Why Resume is off for a paused schedule (admins resume only what an admin paused, KOBE-173). */
function resumeBlocked(s: Schedule): string | undefined {
  if (s.active || s.pausedBy === "team_admin") return undefined;
  return s.pausedBy === "deactivation"
    ? "Only its owner can resume it, after their access is restored."
    : "Only its owner can resume this schedule.";
}

function Row({
  schedule: s,
  owner,
  busy,
  onToggle,
}: {
  readonly schedule: Schedule;
  readonly owner: string;
  readonly busy: boolean;
  readonly onToggle: () => void;
}) {
  const when = describeRecurrence(s.recurrence);
  const blocked = resumeBlocked(s);
  return (
    <tr>
      <th scope="row">{owner}</th>
      <td>
        {when} <span className={styles.hint}>({s.tz})</span>
      </td>
      <td>{statusOf(s)}</td>
      <td>{formatInZone(s.nextDueAt, s.tz)}</td>
      <td className={styles.actions}>
        <button
          type="button"
          aria-label={`${s.active ? "Pause" : "Resume"} ${owner}'s schedule (${when})`}
          disabled={busy || blocked !== undefined}
          title={blocked}
          onClick={onToggle}
        >
          {s.active ? "Pause" : "Resume"}
        </button>
      </td>
    </tr>
  );
}

/**
 * Team schedules (spec D32, `/v1/schedules?scope=team`, KOBE-173/180): every member's scheduled
 * runs, which a team admin may pause, and resume when an admin paused them. Prompts are the
 * owner's and are not shown here; a schedule is named by its owner and recurrence.
 */
export function TeamSchedulesPage() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const api = useMemo(() => createSchedulesApi(teamId), [teamId]);
  const { state, reload } = useResource(() => api.listTeam());
  const roster = useResource(() => listTeamMembers(teamId));
  const mutation = useMutation();
  const members: readonly TeamMember[] = roster.state.status === "ready" ? roster.state.data : [];
  const ownerOf = (userId: string) =>
    members.find((m) => m.userId === userId)?.name ??
    (roster.state.status === "ready" ? "Former member" : "A member");

  const toggle = async (s: Schedule) => {
    const ok = await mutation.run(
      () => (s.active ? api.pause(s.scheduleId) : api.resume(s.scheduleId)),
      () => (s.active ? "Schedule paused." : "Schedule resumed."),
    );
    if (ok) reload();
  };

  return (
    <>
      <h1>Schedules</h1>
      <p className={styles.hint}>
        Members schedule their own agents to run on a repeat. A schedule you pause stays paused
        until a team admin resumes it; its owner cannot. Schedules of deactivated or removed members
        are paused automatically, and only their owner can resume them.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="the team's schedules">
        {({ schedules }) =>
          schedules.length === 0 ? (
            <p>No one in {access.team.name} has a schedule yet.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Schedules of {access.team.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Owner</th>
                    <th scope="col">Repeats</th>
                    <th scope="col">Status</th>
                    <th scope="col">Next run</th>
                    <th scope="col">
                      <span className={styles.visuallyHidden}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((s) => (
                    <Row
                      key={s.scheduleId}
                      schedule={s}
                      owner={ownerOf(s.userId)}
                      busy={mutation.pending}
                      onToggle={() => void toggle(s)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </>
  );
}
