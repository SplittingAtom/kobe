"use client";

import Link from "next/link";
import { useState } from "react";
import {
  listTeamMembers,
  removeMember,
  setMemberRole,
  type TeamMember,
} from "../../../lib/admin/api/team/members";
import { roleLabel, type TeamRole } from "../../../lib/teams";
import {
  Button,
  PageHeader,
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
} from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

export const TEAM_ROLES: readonly TeamRole[] = ["team_admin", "builder", "member"];

/** Team members and roles (spec D8; `/v1/team/members`). People join by accepting an invitation. */
export function MembersPage() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const { state, reload } = useResource(() => listTeamMembers(teamId));
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  // Bumped after every role change so a refused change resets the row's select.
  const [generationKey, setGenerationKey] = useState(0);

  async function changeRole(member: TeamMember, role: TeamRole, trigger: HTMLElement | null) {
    const self = member.userId === access.user.id;
    if (
      self &&
      role !== "team_admin" &&
      !(await confirm(
        {
          title: "Change your own role?",
          description: "You'll lose the team console.",
          confirmLabel: "Change my role",
        },
        trigger,
      ))
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

  async function remove(member: TeamMember, trigger: HTMLElement | null) {
    const self = member.userId === access.user.id;
    const yes = await confirm(
      self
        ? {
            title: `Leave ${access.team.name}?`,
            description: "You lose access to its threads and agents.",
            confirmLabel: "Leave team",
          }
        : {
            title: `Remove ${member.name} from ${access.team.name}?`,
            description: "They lose access at once.",
            confirmLabel: `Remove ${member.name}`,
          },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => removeMember(teamId, member.userId),
      () => `${member.name} was removed from the team.`,
    );
    if (done && self) window.location.assign("/");
    else if (done) reload();
  }

  return (
    <>
      <PageHeader
        title="Members and roles"
        description={
          <>
            Team admins run the team, builders publish agents and skills, members chat. A team
            always keeps at least one team admin.{" "}
            <Link href="/admin/team/invites">Invite someone</Link>.
          </>
        }
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="members">
        {(members) => (
          <Table caption={`Members of ${access.team.name}`}>
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Email</TableHeader>
                <TableHeader>Role</TableHeader>
                <TableHeader>Joined</TableHeader>
                <TableHeader>
                  <span className="sr-only">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.userId}>
                  <TableRowHeader>
                    {m.name}
                    {m.userId === access.user.id && " (you)"}
                  </TableRowHeader>
                  <TableCell>{m.email}</TableCell>
                  <TableCell>
                    <RoleCell
                      key={`${m.userId}:${m.role}:${generationKey}`}
                      member={m}
                      pending={mutation.pending}
                      onSave={(role, trigger) => changeRole(m, role, trigger)}
                    />
                  </TableCell>
                  <TableCell>
                    <DateTime value={m.joinedAt} />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={mutation.pending}
                      onClick={(e) => void remove(m, eventTrigger(e))}
                    >
                      {m.userId === access.user.id ? "Leave team" : "Remove"}
                      <span className="sr-only"> {m.name}</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ResourceView>
      {confirmDialog}
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
  readonly onSave: (role: TeamRole, trigger: HTMLElement | null) => Promise<void>;
}) {
  const [role, setRole] = useState<TeamRole>(member.role);
  const id = `role-${member.userId}`;
  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
      aria-label={`Change the role of ${member.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(role, eventTrigger(e));
      }}
    >
      <label htmlFor={id} className="sr-only">
        Role of {member.name}
      </label>
      <Select id={id} value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
        {TEAM_ROLES.map((r) => (
          <option key={r} value={r}>
            {roleLabel(r)}
          </option>
        ))}
      </Select>
      <Button type="submit" size="sm" disabled={pending || role === member.role}>
        Save<span className="sr-only"> role of {member.name}</span>
      </Button>
    </form>
  );
}
