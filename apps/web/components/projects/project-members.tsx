"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../lib/api/client";
import { worded, type Project, type ProjectMember, type ProjectRole } from "../../lib/projects/api";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView, confirmed } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
import styles from "../admin/admin.module.css";
import { useProjectsApi, useRoster } from "./use-projects";

const ROLES: readonly ProjectRole[] = ["owner", "member"];

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

  const act = async <T,>(change: () => Promise<ApiResult<T>>, notice: string) => {
    if (
      await mutation.run(
        async () => worded(await change()),
        () => notice,
      )
    )
      reload();
  };

  return (
    <section aria-label="Members">
      <h2>Members</h2>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="members">
        {(data) => {
          const listed = new Set(data.members.map((m) => m.userId));
          return (
            <>
              <p className={styles.hint}>
                {data.membersMode === "team"
                  ? "Everyone in the team is a member. Only owners are listed; switch to selected people to choose who is in."
                  : "Only the people listed here are members."}
              </p>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption>Project members</caption>
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Role</th>
                      <th scope="col">Added</th>
                      <th scope="col">
                        <span className={styles.visuallyHidden}>Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.members.map((m) => (
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
                        onRemove={() => {
                          if (!confirmed(`Remove ${roster.nameOf(m.userId)} from this project?`))
                            return;
                          void act(
                            () => api.removeMember(project.id, m.userId),
                            `Removed ${roster.nameOf(m.userId)}.`,
                          );
                        }}
                      />
                    ))}
                  </tbody>
                </table>
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
    </section>
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
  readonly onRole: (role: ProjectRole) => Promise<void>;
  readonly onRemove: () => void;
}) {
  const [role, setRole] = useState(member.role);
  return (
    <tr>
      <th scope="row">
        {name}
        {isMe && " (you)"}
      </th>
      <td>
        {editable ? (
          <form
            className={styles.actions}
            aria-label={`Change the role of ${name}`}
            onSubmit={(e) => {
              e.preventDefault();
              void onRole(role);
            }}
          >
            <label className={styles.visuallyHidden} htmlFor={`pm-${member.userId}`}>
              Project role of {name}
            </label>
            <select
              id={`pm-${member.userId}`}
              value={role}
              onChange={(e) => setRole(e.target.value as ProjectRole)}
            >
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <button type="submit" disabled={pending || role === member.role}>
              Save<span className={styles.visuallyHidden}> role of {name}</span>
            </button>
          </form>
        ) : (
          member.role
        )}
      </td>
      <td>
        <DateTime value={member.addedAt} />
      </td>
      <td>
        {editable && (
          <button type="button" disabled={pending} onClick={onRemove}>
            Remove<span className={styles.visuallyHidden}> {name}</span>
          </button>
        )}
      </td>
    </tr>
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
  readonly onAdd: (userId: string, role: ProjectRole) => Promise<void>;
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
    <form className={styles.form} aria-label="Add a member" onSubmit={(e) => void submit(e)}>
      <label>
        Person
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose a person</option>
          {candidates.map((c) => (
            <option key={c.userId} value={c.userId}>
              {c.name} ({c.email})
            </option>
          ))}
        </select>
      </label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
          {ROLES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pending || userId === ""}>
        Add member
      </button>
    </form>
  );
}
