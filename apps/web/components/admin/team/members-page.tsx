"use client";

import Link from "next/link";
import { useState } from "react";
import {
  listTeamMembers,
  listTeamSsoMappings,
  removeMember,
  setMemberRole,
  takeOverMember,
  type TeamMember,
} from "../../../lib/admin/api/team/members";
import { roleLabel, type TeamRole } from "../../../lib/teams";
import {
  Button,
  PageHeader,
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
} from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

export const TEAM_ROLES: readonly TeamRole[] = ["team_admin", "contributor", "member"];

/**
 * Team members and roles (spec D8; `/v1/team/members`). People join by accepting an invitation;
 * a Site admin can also add existing users from the Site console (KOBE-638), shown here.
 */
/** A membership Kobe made for the Skill reviewer grant (KOBE-331 review H1b). */
export const ADDED_BY_GRANT = "Added by Kobe: Skill reviewer";

/** A membership an identity provider's access mappings manage (KOBE-627, SSO10). */
export const managedByLabel = (providerName: string) => `Managed by ${providerName}`;

/** A membership a Site admin made from the Site console, no invitation (KOBE-638). */
export const ADDED_BY_SITE_ADMIN = "Added by a site admin";

/** How the member joined, in words (KOBE-638: the Site console's roster column). */
export function joinedVia(m: TeamMember): string {
  if (m.managedBy) return managedByLabel(m.managedBy.providerName);
  if (m.addedVia === "skill_reviewer_grant") return ADDED_BY_GRANT;
  if (m.addedVia === "site_admin") return ADDED_BY_SITE_ADMIN;
  return "Invitation";
}

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

  async function takeOver(member: TeamMember, trigger: HTMLElement | null) {
    const provider = member.managedBy?.providerName ?? "the identity provider";
    const yes = await confirm(
      {
        title: `Take over ${member.name}'s membership?`,
        description: `${provider} stops managing it: from now on only team admins change or remove it, even when their access in ${provider} changes.`,
        confirmLabel: "Take over",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => takeOverMember(teamId, member.userId),
      () => `${member.name}'s membership is now managed by the team.`,
    );
    if (done) reload();
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
            Team admins run the team and the workspace's settings, contributors publish agents and
            skills and create projects, members chat. A team always keeps at least one team admin.{" "}
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
                    {m.deactivated && <span className="block text-xs">Deactivated</span>}
                  </TableRowHeader>
                  <TableCell>{m.email}</TableCell>
                  <TableCell>
                    {m.managedBy ? (
                      <>
                        {roleLabel(m.role)}
                        <span className="block text-xs">
                          {managedByLabel(m.managedBy.providerName)}
                        </span>
                      </>
                    ) : (
                      <RoleCell
                        key={`${m.userId}:${m.role}:${generationKey}`}
                        member={m}
                        pending={mutation.pending}
                        onSave={(role, trigger) => changeRole(m, role, trigger)}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <DateTime value={m.joinedAt} />
                    {m.addedVia === "skill_reviewer_grant" && (
                      <span className="block text-xs">{ADDED_BY_GRANT}</span>
                    )}
                    {m.addedVia === "site_admin" && (
                      <span className="block text-xs">{ADDED_BY_SITE_ADMIN}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {m.managedBy ? (
                      // The identity provider decides; Take over makes the row the team's own.
                      // Never your own row: another team admin takes it over (review finding 4).
                      m.userId === access.user.id ? null : (
                        <Button
                          size="sm"
                          disabled={mutation.pending}
                          onClick={(e) => void takeOver(m, eventTrigger(e))}
                        >
                          Take over<span className="sr-only"> membership of {m.name}</span>
                        </Button>
                      )
                    ) : (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={mutation.pending}
                        onClick={(e) => void remove(m, eventTrigger(e))}
                      >
                        {m.userId === access.user.id ? "Leave team" : "Remove"}
                        <span className="sr-only"> {m.name}</span>
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ResourceView>
      <TeamSsoMappings teamId={teamId} />
      {confirmDialog}
    </>
  );
}

/**
 * The single sign-on access mappings that target this team, read-only (spec sso §7): loaded on
 * request, since most teams have none. Site admins edit them in the Site console.
 */
function TeamSsoMappings({ teamId }: { readonly teamId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Single sign-on access">
      {open ? (
        <TeamSsoMappingList teamId={teamId} />
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>
          Show access mappings
        </Button>
      )}
    </Section>
  );
}

function TeamSsoMappingList({ teamId }: { readonly teamId: string }) {
  const { state } = useResource(() => listTeamSsoMappings(teamId));
  return (
    <ResourceView state={state} label="access mappings">
      {(mappings) =>
        mappings.length === 0 ? (
          <p className="text-sm">No identity provider grants access to this team.</p>
        ) : (
          <Table caption="Access mappings for this team (set by site admins)">
            <TableHead>
              <TableRow>
                <TableHeader>Identity provider</TableHeader>
                <TableHeader>App role or group</TableHeader>
                <TableHeader>Team role</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {mappings.map((m) => (
                <TableRow key={m.id}>
                  <TableRowHeader>{m.providerName}</TableRowHeader>
                  <TableCell>
                    <code>{m.claimValue}</code>
                  </TableCell>
                  <TableCell>{roleLabel(m.role)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      }
    </ResourceView>
  );
}

/** A member's role: choosing doesn't change anything until Save (keyboard-safe). */
export function RoleCell({
  member,
  pending,
  onSave,
  idPrefix = "",
}: {
  readonly member: Pick<TeamMember, "userId" | "name" | "role">;
  /** Keeps ids unique when several rosters are on one page (the Site console's teams). */
  readonly idPrefix?: string;
  readonly pending: boolean;
  readonly onSave: (role: TeamRole, trigger: HTMLElement | null) => Promise<void>;
}) {
  const [role, setRole] = useState<TeamRole>(member.role);
  const id = `role-${idPrefix}${member.userId}`;
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
