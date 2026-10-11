"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { MAX_ACTIVE_SCHEDULES_PER_USER } from "@kobe/protocol";
import {
  createSchedulesApi,
  type Schedule,
  type ScheduleAgent,
  type ScheduleDraft,
} from "../../lib/schedules/api";
import { describeRecurrence, formatInZone } from "../../lib/schedules/format";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { ResourceView, confirmed } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
import styles from "../admin/admin.module.css";
import { ScheduleForm } from "./schedule-form";

type Editing = { readonly mode: "new" } | { readonly mode: "edit"; readonly schedule: Schedule };

function statusOf(s: Schedule): string {
  if (s.active) return "Active";
  if (s.pausedBy === "team_admin") return "Paused by a team admin";
  if (s.pausedBy === "deactivation") return "Paused (your access was deactivated)";
  return "Paused";
}

function Row({
  schedule: s,
  agentName,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  readonly schedule: Schedule;
  readonly agentName: string;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onToggle: () => void;
  readonly onDelete: () => void;
}) {
  const label = s.prompt.slice(0, 80);
  const adminPaused = !s.active && s.pausedBy === "team_admin";
  return (
    <tr>
      <th scope="row">{s.prompt}</th>
      <td>{agentName}</td>
      <td>
        {describeRecurrence(s.recurrence)} <span className={styles.hint}>({s.tz})</span>
      </td>
      <td>{statusOf(s)}</td>
      <td>{formatInZone(s.nextDueAt, s.tz)}</td>
      <td>{s.lastRunId === null ? "Not yet" : "Ran"}</td>
      <td className={styles.actions}>
        <button
          type="button"
          aria-label={`Edit schedule ${label}`}
          disabled={busy}
          onClick={onEdit}
        >
          Edit
        </button>{" "}
        <button
          type="button"
          aria-label={`${s.active ? "Pause" : "Resume"} schedule ${label}`}
          disabled={busy || adminPaused}
          title={adminPaused ? "Only a team admin can resume this schedule." : undefined}
          onClick={onToggle}
        >
          {s.active ? "Pause" : "Resume"}
        </button>{" "}
        <button
          type="button"
          aria-label={`Delete schedule ${label}`}
          disabled={busy}
          onClick={onDelete}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

/** The member's own schedules (`/v1/schedules`, KOBE-173/175). Text is rendered as plain text. */
export function MySchedulesPage() {
  const teamId = useTeamAccess().team.id;
  const api = useMemo(() => createSchedulesApi(teamId), [teamId]);
  const { state, reload } = useResource(() => api.list());
  const agentsState = useResource(() => api.agents());
  const mutation = useMutation();
  const [editing, setEditing] = useState<Editing | null>(null);
  const agents: readonly ScheduleAgent[] =
    agentsState.state.status === "ready" ? agentsState.state.data : [];
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? "Unknown agent";

  const save = async (draft: ScheduleDraft) => {
    const ok = await mutation.run(
      () =>
        editing?.mode === "edit"
          ? api.update(editing.schedule.scheduleId, draft)
          : api.create(draft),
      () => "Schedule saved.",
    );
    if (ok) {
      setEditing(null);
      reload();
    }
  };
  const change = async (call: () => ReturnType<typeof api.pause>, notice: string) => {
    if (await mutation.run(call, () => notice)) reload();
  };
  const remove = async (s: Schedule) => {
    if (!confirmed("Delete this schedule? Conversations it already started stay.")) return;
    if (
      await mutation.run(
        () => api.remove(s.scheduleId),
        () => "Schedule deleted.",
      )
    )
      reload();
  };

  return (
    <>
      <h1>My schedules</h1>
      <p className={styles.hint}>
        A schedule sends a prompt to one of your agents on a repeat. Each run starts a conversation
        in the Scheduled folder. You can have up to {MAX_ACTIVE_SCHEDULES_PER_USER} active schedules
        across all your teams.
      </p>
      {editing === null && (
        <p>
          <button
            type="button"
            onClick={() => {
              mutation.clear();
              setEditing({ mode: "new" });
            }}
          >
            New schedule
          </button>
        </p>
      )}
      {editing !== null && (
        <ScheduleForm
          key={editing.mode === "edit" ? editing.schedule.scheduleId : "new"}
          editing={editing.mode === "edit" ? editing.schedule : null}
          agents={agents}
          error={mutation.error}
          pending={mutation.pending}
          onSubmit={(d) => void save(d)}
          onCancel={() => {
            mutation.clear();
            setEditing(null);
          }}
        />
      )}
      {editing === null && <MutationStatus error={mutation.error} notice={mutation.notice} />}
      <ResourceView state={state} label="your schedules">
        {({ schedules, activeCount }) =>
          schedules.length === 0 ? (
            <p>
              No schedules yet. Pick one of your <Link href="/me/agents">agents</Link> and create a
              schedule for it.
            </p>
          ) : (
            <>
              <p className={styles.hint}>
                {activeCount} of {MAX_ACTIVE_SCHEDULES_PER_USER} active schedules used.
              </p>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption>Your schedules</caption>
                  <thead>
                    <tr>
                      <th scope="col">Prompt</th>
                      <th scope="col">Agent</th>
                      <th scope="col">Repeats</th>
                      <th scope="col">Status</th>
                      <th scope="col">Next run</th>
                      <th scope="col">Last run</th>
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
                        agentName={nameOf(s.agentId)}
                        busy={mutation.pending}
                        onEdit={() => {
                          mutation.clear();
                          setEditing({ mode: "edit", schedule: s });
                        }}
                        onToggle={() =>
                          void change(
                            () => (s.active ? api.pause(s.scheduleId) : api.resume(s.scheduleId)),
                            s.active ? "Schedule paused." : "Schedule resumed.",
                          )
                        }
                        onDelete={() => void remove(s)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        }
      </ResourceView>
    </>
  );
}
