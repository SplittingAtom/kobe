"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../lib/api/client";
import {
  PROJECT_MEMBER_ROLES,
  worded,
  type Project,
  type ProjectMember,
  type ProjectMemberRole,
} from "../../lib/projects/api";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useFocusAfterRemoval } from "../admin/use-focus-after-removal";
import { useMutation, useResource } from "../admin/use-resource";
import {
  Button,
  Field,
  Notice,
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

/** Listed roles only (RV1): every workspace member who is not listed is a reader. */
const ROLES = PROJECT_MEMBER_ROLES;

/** What each role may do (PR3), shown under the list. */
const ROLES_NOTE =
  "Owners manage the project and its people; editors check out, edit and commit its files. Everyone else in the workspace is a reader: they browse, read history and start conversations in it.";

/** The section's heading: focus lands here when a removal empties the list. */
const HEADING = "project-members";

/**
 * People of one project (PR3, RV1): the listed owners and editors (everyone else in the workspace
 * reads); add, re-role and remove for owners and team admins (the last owner stays,
 * `last_owner`; removing someone makes them a reader); a list for everyone else.
 */
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
              <p className="m-0 mb-2 text-sm text-console-muted">{ROLES_NOTE}</p>
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
              {!data.members.some((m) => m.role === "owner") && (
                <Notice tone="warn" role="note">
                  <p>
                    {editable
                      ? "No owner: assign one below. Team admins manage the project meanwhile."
                      : "No owner. Team admins manage the project meanwhile."}
                  </p>
                </Notice>
              )}
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
              {editable && (
                <TransferOwner
                  people={roster.state.status === "ready" ? roster.state.data : []}
                  owners={data.members.filter((m) => m.role === "owner").map((m) => m.userId)}
                  pending={mutation.pending}
                  onTransfer={(userId) =>
                    act(
                      () => api.transferOwner(project.id, userId),
                      `${roster.nameOf(userId)} owns ${project.name} now.`,
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
  readonly onRole: (role: ProjectMemberRole) => Promise<unknown>;
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
              onChange={(e) => setRole(e.target.value as ProjectMemberRole)}
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
  readonly onAdd: (userId: string, role: ProjectMemberRole) => Promise<unknown>;
}) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<ProjectMemberRole>("editor");
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
          <Select value={role} onChange={(e) => setRole(e.target.value as ProjectMemberRole)}>
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

/**
 * Ownership transfer (PR5): the person picked becomes an owner; an owner handing over stays an
 * editor, a team admin assigning one demotes nobody. The server checks they are in the workspace.
 */
function TransferOwner({
  people,
  owners,
  pending,
  onTransfer,
}: {
  readonly people: readonly {
    readonly userId: string;
    readonly name: string;
    readonly email: string;
  }[];
  readonly owners: readonly string[];
  readonly pending: boolean;
  readonly onTransfer: (userId: string) => Promise<unknown>;
}) {
  const [userId, setUserId] = useState("");
  const candidates = people.filter((p) => !owners.includes(p.userId));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (userId === "") return;
    await onTransfer(userId);
    setUserId("");
  }
  return (
    <form id="project-owner" aria-label="Transfer ownership" onSubmit={(e) => void submit(e)}>
      <FormRow>
        <Field
          label="New owner"
          hint="An owner who hands over stays an editor; a team admin assigning one demotes nobody."
        >
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose a person</option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.name} ({c.email})
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" disabled={pending || userId === ""}>
          Transfer ownership
        </Button>
      </FormRow>
    </form>
  );
}
