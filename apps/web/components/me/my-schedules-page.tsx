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
import { ResourceView } from "../admin/parts";
import { useFocusAfterRemoval } from "../admin/use-focus-after-removal";
import { useMutation, useResource } from "../admin/use-resource";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  eventTrigger,
  useConfirm,
} from "../ui/console";
import { ScheduleForm } from "./schedule-form";

/** The list's heading: focus lands here when a delete empties the list. */
const HEADING = "your-schedules";

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
  readonly onDelete: (trigger: HTMLElement | null) => void;
}) {
  const label = s.prompt.slice(0, 80);
  const adminPaused = !s.active && s.pausedBy === "team_admin";
  return (
    <TableRow>
      <TableRowHeader className="font-normal break-words">{s.prompt}</TableRowHeader>
      <TableCell>{agentName}</TableCell>
      <TableCell>
        {describeRecurrence(s.recurrence)}{" "}
        <span className="text-sm text-console-muted">({s.tz})</span>
      </TableCell>
      <TableCell>
        <Badge tone={s.active ? "running" : s.pausedBy === null ? "neutral" : "attention"}>
          {statusOf(s)}
        </Badge>
      </TableCell>
      <TableCell>{formatInZone(s.nextDueAt, s.tz)}</TableCell>
      <TableCell>{s.lastRunId === null ? "Not yet" : "Ran"}</TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" aria-label={`Edit schedule ${label}`} disabled={busy} onClick={onEdit}>
            Edit
          </Button>
          <Button
            size="sm"
            aria-label={`${s.active ? "Pause" : "Resume"} schedule ${label}`}
            disabled={busy || adminPaused}
            title={adminPaused ? "Only a team admin can resume this schedule." : undefined}
            onClick={onToggle}
          >
            {s.active ? "Pause" : "Resume"}
          </Button>
          <Button
            size="sm"
            variant="danger"
            data-remove=""
            aria-label={`Delete schedule ${label}`}
            disabled={busy}
            onClick={(e) => onDelete(eventTrigger(e))}
          >
            Delete
          </Button>
        </div>
      </TableCell>
    </TableRow>
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
  const [confirm, confirmDialog] = useConfirm();
  const focus = useFocusAfterRemoval(
    state.status === "ready" ? state.data.schedules.map((s) => s.scheduleId) : null,
    HEADING,
  );
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
  const remove = async (s: Schedule, index: number, trigger: HTMLElement | null) => {
    const yes = await confirm(
      {
        title: "Delete this schedule?",
        description: "Conversations it already started stay.",
        confirmLabel: "Delete schedule",
      },
      trigger,
    );
    if (!yes) return;
    if (
      await mutation.run(
        () => api.remove(s.scheduleId),
        () => "Schedule deleted.",
      )
    ) {
      focus.removed(s.scheduleId, index);
      reload();
    }
  };

  return (
    <>
      <PageHeader
        title="My schedules"
        description={`A schedule sends a prompt to one of your agents on a repeat. Each run starts a conversation in the Scheduled folder. You can have up to ${MAX_ACTIVE_SCHEDULES_PER_USER} active schedules across all your teams.`}
        actions={
          editing === null && (
            <Button
              variant="primary"
              onClick={() => {
                mutation.clear();
                setEditing({ mode: "new" });
              }}
            >
              New schedule
            </Button>
          )
        }
      />
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
      <Section id={HEADING} title="Your schedules">
        <ResourceView state={state} label="your schedules">
          {({ schedules, activeCount }) =>
            schedules.length === 0 ? (
              <EmptyState title="No schedules yet.">
                Pick one of your <Link href="/me/agents">agents</Link> and create a schedule for it.
              </EmptyState>
            ) : (
              <div ref={focus.container}>
                <p className="m-0 mb-2 text-sm text-console-muted">
                  {activeCount} of {MAX_ACTIVE_SCHEDULES_PER_USER} active schedules used.
                </p>
                <Table caption="Your schedules" hideCaption>
                  <TableHead>
                    <TableRow>
                      <TableHeader>Prompt</TableHeader>
                      <TableHeader>Agent</TableHeader>
                      <TableHeader>Repeats</TableHeader>
                      <TableHeader>Status</TableHeader>
                      <TableHeader>Next run</TableHeader>
                      <TableHeader>Last run</TableHeader>
                      <TableHeader>
                        <span className="sr-only">Actions</span>
                      </TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {schedules.map((s, index) => (
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
                        onDelete={(trigger) => void remove(s, index, trigger)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )
          }
        </ResourceView>
      </Section>
      {confirmDialog}
    </>
  );
}
