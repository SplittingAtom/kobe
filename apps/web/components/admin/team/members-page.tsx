"use client";

import Link from "next/link";
import { useState } from "react";
import {
  listTeamMembers,
  removeMember,
  setMemberRole,
  type TeamMember,
} from "../../../lib/admin/api/team";
import { roleLabel, type TeamRole } from "../../../lib/teams";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

export const TEAM_ROLES: readonly TeamRole[] = ["team_admin", "builder", "member"];

/** Team members and roles (spec D8; `/v1/team/members`). People join by accepting an invitation. */
export function MembersPage() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const { state, reload } = useResource(() => listTeamMembers(teamId));
  const mutation = useMutation();
  // Bumped after every role change so a refused change resets the row's select.
  const [generationKey, setGenerationKey] = useState(0);

  async function changeRole(member: TeamMember, role: TeamRole) {
    const self = member.userId === access.user.id;
    if (
      self &&
      role !== "team_admin" &&
      !confirmed("Change your own role? You'll lose the team console.")
    ) {
      reload();
      return;
    }
    const done = await mutation.run(
      () => setMemberRole(teamId, member.userId, role),
      () => `${member.name} is now ${roleLabel(role)}.`,
    );
    if (done && self) window.location.assign("/");
    else {
      // Reload either way; a refused change (e.g. the last team admin) resets the select.
      setGenerationKey((n) => n + 1);
      reload();
    }
  }

  async function remove(member: TeamMember) {
    const self = member.userId === access.user.id;
    const question = self
      ? `Leave ${access.team.name}? You lose access to its threads and agents.`
      : `Remove ${member.name} from ${access.team.name}? They lose access at once.`;
    if (!confirmed(question)) return;
    const done = await mutation.run(
      () => removeMember(teamId, member.userId),
      () => `${member.name} was removed from the team.`,
    );
    if (done && self) window.location.assign("/");
    else if (done) reload();
  }

  return (
    <>
      <h1>Members and roles</h1>
      <p className={styles.hint}>
        Team admins run the team, builders publish agents and skills, members chat. A team always
        keeps at least one team admin. <Link href="/admin/team/invites">Invite someone</Link>.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="members">
        {(members) => (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Members of {access.team.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Joined</th>
                  <th scope="col">
                    <span className={styles.visuallyHidden}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId}>
                    <th scope="row">
                      {m.name}
                      {m.userId === access.user.id && " (you)"}
                    </th>
                    <td>{m.email}</td>
                    <td>
                      <RoleCell
                        key={`${m.userId}:${m.role}:${generationKey}`}
                        member={m}
                        pending={mutation.pending}
                        onSave={(role) => changeRole(m, role)}
                      />
                    </td>
                    <td>
                      <DateTime value={m.joinedAt} />
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={mutation.pending}
                        onClick={() => void remove(m)}
                      >
                        {m.userId === access.user.id ? "Leave team" : "Remove"}
                        <span className={styles.visuallyHidden}> {m.name}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ResourceView>
    </>
  );
}

/** A member's role: choosing doesn't change anything until Save (keyboard-safe). */
function RoleCell({
  member,
  pending,
  onSave,
}: {
  readonly member: TeamMember;
  readonly pending: boolean;
  readonly onSave: (role: TeamRole) => Promise<void>;
}) {
  const [role, setRole] = useState<TeamRole>(member.role);
  const id = `role-${member.userId}`;
  return (
    <form
      className={styles.actions}
      aria-label={`Change the role of ${member.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(role);
      }}
    >
      <label htmlFor={id} className={styles.visuallyHidden}>
        Role of {member.name}
      </label>
      <select id={id} value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
        {TEAM_ROLES.map((r) => (
          <option key={r} value={r}>
            {roleLabel(r)}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending || role === member.role}>
        Save<span className={styles.visuallyHidden}> role of {member.name}</span>
      </button>
    </form>
  );
}
