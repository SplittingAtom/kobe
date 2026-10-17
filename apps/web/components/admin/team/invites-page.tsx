"use client";

import { useState, type FormEvent } from "react";
import {
  inviteToTeam,
  listTeamInvites,
  revokeTeamInvite,
  type TeamInvite,
} from "../../../lib/admin/api/team/invites";
import { roleLabel, type TeamRole } from "../../../lib/teams";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  FormRow,
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
  TextInput,
  useConfirm,
} from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { TEAM_ROLES } from "./members-page";

/**
 * Team invitations (KOBE-13; `/v1/team/invites`). The answer is the same whether or not the
 * address has a Kobe account, so the page never says which. The reference page for the console
 * primitives (KOBE-294): KOBE-295 and KOBE-296 move the other pages the same way.
 */
export function TeamInvitesPage() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const { state, reload } = useResource(() => listTeamInvites(teamId));
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("member");

  async function onInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const address = email.trim();
    const done = await mutation.run(
      () => inviteToTeam(teamId, address, role),
      () =>
        `Invited ${address} as ${roleLabel(role)}. They join when they accept while signed in to Kobe.`,
    );
    if (done) {
      setEmail("");
      reload();
    }
  }

  async function revoke(invite: TeamInvite) {
    const yes = await confirm({
      title: `Revoke the invitation to ${invite.email}?`,
      description: "The link in their email stops working. You can invite them again later.",
      confirmLabel: "Revoke",
    });
    if (!yes) return;
    const done = await mutation.run(
      () => revokeTeamInvite(teamId, invite.id),
      () => `Revoked the invitation to ${invite.email}.`,
    );
    if (done) reload();
  }

  return (
    <>
      <PageHeader
        title="Invitations"
        description="Invitations last 14 days. Someone without a Kobe account also needs a site invitation from a site admin; they see yours after they sign up."
      />
      <form onSubmit={onInvite} aria-label="Invite to the team">
        <FormRow>
          <Field label="Email address">
            <TextInput
              type="email"
              required
              maxLength={254}
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
              {TEAM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" disabled={mutation.pending}>
            Invite
          </Button>
        </FormRow>
      </form>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <Section title="Open invitations">
        <ResourceView state={state} label="invitations">
          {(invites) =>
            invites.length === 0 ? (
              <EmptyState title="No open invitations.">
                Invite someone with the form above.
              </EmptyState>
            ) : (
              <Table caption={`Open invitations to ${access.team.name}`}>
                <TableHead>
                  <TableRow>
                    <TableHeader>Email</TableHeader>
                    <TableHeader>Role</TableHeader>
                    <TableHeader>Invited by</TableHeader>
                    <TableHeader>Expires</TableHeader>
                    <TableHeader>Status</TableHeader>
                    <TableHeader>
                      <span className="sr-only">Actions</span>
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {invites.map((i) => (
                    <TableRow key={i.id}>
                      <TableRowHeader>{i.email}</TableRowHeader>
                      <TableCell>{roleLabel(i.role)}</TableCell>
                      <TableCell>{i.invitedBy.name}</TableCell>
                      <TableCell>
                        <DateTime value={i.expiresAt} />
                      </TableCell>
                      <TableCell>
                        {i.status === "expired" ? (
                          <Badge tone="attention">Expired</Badge>
                        ) : (
                          <Badge>Pending</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={mutation.pending}
                          onClick={() => void revoke(i)}
                        >
                          Revoke
                          <span className="sr-only"> invitation to {i.email}</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </ResourceView>
      </Section>
      {confirmDialog}
    </>
  );
}
