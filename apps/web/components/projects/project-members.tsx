"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../lib/api/client";
import { worded, type Project, type ProjectMember, type ProjectRole } from "../../lib/projects/api";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useFocusAfterRemoval } from "../admin/use-focus-after-removal";
import { useMutation, useResource } from "../admin/use-resource";
import {
  Button,
  Field,
  FormRow,
  Section,
  Select,
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
import { useProjectsApi, useRoster } from "./use-projects";

const ROLES: readonly ProjectRole[] = ["owner", "member"];

/** The section's heading: focus lands here when a removal empties the list. */
const HEADING = "project-members";

/** Members of one project: add, remove and roles for owners and admins; a list for everyone else. */
export function ProjectMembers({
  project,
  canManage,
}: {
  readonly project: Project;
  readonly canManage: boolean;
}) {
  const api = useProjectsApi();
  const me = useTeamAccess().user.id;
  const { state, reload } = useResource(() => api.members(project.id));
  const roster = useRoster();
  const mutation = useMutation();
  const editable = canManage && project.archivedAt === null;
  const [confirm, confirmDialog] = useConfirm();
  const focus = useFocusAfterRemoval(
    state.status === "ready" ? state.data.members.map((m) => m.userId) : null,
    HEADING,
  );

  const act = async <T,>(change: () => Promise<ApiResult<T>>, notice: string) => {
    const done = await mutation.run(
      async () => worded(await change()),
      () => notice,
    );
    if (done) reload();
    return done;
  };

  return (
    <Section id={HEADING} title="Members">
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="members">
        {(data) => {
          const listed = new Set(data.members.map((m) => m.userId));
          return (
            <>
              <p className="m-0 mb-2 text-sm text-console-muted">
                {data.membersMode === "team"
                  ? "Everyone in the team is a member. Only owners are listed; switch to selected people to choose who is in."
                  : "Only the people listed here are members."}
              </p>
              <div ref={focus.container}>
                <Table caption="Project members" hideCaption>
                  <TableHead>
                    <TableRow>
                      <TableHeader>Person</TableHeader>
                      <TableHeader>Role</TableHeader>
                      <TableHeader>Added</TableHeader>
                      <TableHeader>
                        <span className="sr-only">Actions</span>
                      </TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.members.map((m, index) => (
                      <MemberRow
                        key={`${m.userId}:${m.role}`}
                        member={m}
                        name={roster.nameOf(m.userId)}
                        isMe={m.userId === me}
                        editable={editable}
                        pending={mutation.pending}
                        onRole={(role) =>
                          act(
                            () => api.setMemberRole(project.id, m.userId, role),
                            `${roster.nameOf(m.userId)} is now ${role}.`,
                          )
                        }
                        onRemove={async (trigger) => {
                          const yes = await confirm(
                            {
                              title: `Remove ${roster.nameOf(m.userId)} from this project?`,
                              confirmLabel: "Remove",
                            },
                            trigger,
                          );
                          if (!yes) return;
                          const done = await act(
                            () => api.removeMember(project.id, m.userId),
                            `Removed ${roster.nameOf(m.userId)}.`,
                          );
                          // Once the reloaded list drops the row: the next Remove, or the heading.
                          if (done) focus.removed(m.userId, index);
                        }}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
              {editable && (
                <AddMember
                  candidates={
                    roster.state.status === "ready"
                      ? roster.state.data.filter((p) => !listed.has(p.userId))
                      : []
                  }
                  pending={mutation.pending}
                  onAdd={(userId, role) =>
                    act(
                      () => api.addMember(project.id, userId, role),
                      `Added ${roster.nameOf(userId)}.`,
                    )
                  }
                />
              )}
            </>
          );
        }}
      </ResourceView>
      {confirmDialog}
    </Section>
  );
}

function MemberRow({
  member,
  name,
  isMe,
  editable,
  pending,
  onRole,
  onRemove,
}: {
  readonly member: ProjectMember;
  readonly name: string;
  readonly isMe: boolean;
  readonly editable: boolean;
  readonly pending: boolean;
  readonly onRole: (role: ProjectRole) => Promise<unknown>;
  readonly onRemove: (trigger: HTMLElement | null) => Promise<void>;
}) {
  const [role, setRole] = useState(member.role);
  return (
    <TableRow>
      <TableRowHeader>
        {name}
        {isMe && " (you)"}
      </TableRowHeader>
      <TableCell>
        {editable ? (
          <form
            className="flex flex-wrap items-center gap-1.5"
            aria-label={`Change the role of ${name}`}
            onSubmit={(e) => {
              e.preventDefault();
              void onRole(role);
            }}
          >
            <label className="sr-only" htmlFor={`pm-${member.userId}`}>
              Project role of {name}
            </label>
            <Select
              id={`pm-${member.userId}`}
              value={role}
              onChange={(e) => setRole(e.target.value as ProjectRole)}
            >
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
            <Button type="submit" size="sm" disabled={pending || role === member.role}>
              Save<span className="sr-only"> role of {name}</span>
            </Button>
          </form>
        ) : (
          member.role
        )}
      </TableCell>
      <TableCell>
        <DateTime value={member.addedAt} />
      </TableCell>
      <TableCell>
        {editable && (
          <Button
            size="sm"
            variant="danger"
            data-remove=""
            disabled={pending}
            onClick={(e) => void onRemove(eventTrigger(e))}
          >
            Remove<span className="sr-only"> {name}</span>
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function AddMember({
  candidates,
  pending,
  onAdd,
}: {
  readonly candidates: readonly {
    readonly userId: string;
    readonly name: string;
    readonly email: string;
  }[];
  readonly pending: boolean;
  readonly onAdd: (userId: string, role: ProjectRole) => Promise<unknown>;
}) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<ProjectRole>("member");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (userId === "") return;
    await onAdd(userId, role);
    setUserId("");
  }
  return (
    <form aria-label="Add a member" onSubmit={(e) => void submit(e)}>
      <FormRow>
        <Field label="Person">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose a person</option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.name} ({c.email})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={pending || userId === ""}>
          Add member
        </Button>
      </FormRow>
    </form>
  );
}
