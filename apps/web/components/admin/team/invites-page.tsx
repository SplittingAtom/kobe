"use client";

import { useState, type FormEvent } from "react";
import {
  inviteToTeam,
  listTeamInvites,
  revokeTeamInvite,
  type TeamInvite,
} from "../../../lib/admin/api/team/invites";
import { roleLabel, type TeamRole } from "../../../lib/teams";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { TEAM_ROLES } from "./members-page";
import styles from "../admin.module.css";

/**
 * Team invitations (KOBE-13; `/v1/team/invites`). The answer is the same whether or not the
 * address has a Kobe account, so the page never says which.
 */
export function TeamInvitesPage() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const { state, reload } = useResource(() => listTeamInvites(teamId));
  const mutation = useMutation();
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
    if (!confirmed(`Revoke the invitation to ${invite.email}?`)) return;
    const done = await mutation.run(
      () => revokeTeamInvite(teamId, invite.id),
      () => `Revoked the invitation to ${invite.email}.`,
    );
    if (done) reload();
  }

  return (
    <>
      <h1>Invitations</h1>
      <p className={styles.hint}>
        Invitations last 14 days. Someone without a Kobe account also needs an install invitation
        from an install admin; they see yours after they sign up.
      </p>
      <form onSubmit={onInvite} className={styles.form} aria-label="Invite to the team">
        <label>
          Email address
          <input
            type="email"
            required
            maxLength={254}
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
            {TEAM_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={mutation.pending}>
          Invite
        </button>
      </form>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="invitations">
        {(invites) =>
          invites.length === 0 ? (
            <p>No open invitations.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Open invitations to {access.team.name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Email</th>
                    <th scope="col">Role</th>
                    <th scope="col">Invited by</th>
                    <th scope="col">Expires</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className={styles.visuallyHidden}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((i) => (
                    <tr key={i.id}>
                      <th scope="row">{i.email}</th>
                      <td>{roleLabel(i.role)}</td>
                      <td>{i.invitedBy.name}</td>
                      <td>
                        <DateTime value={i.expiresAt} />
                      </td>
                      <td>{i.status === "expired" ? "Expired" : "Pending"}</td>
                      <td>
                        <button
                          type="button"
                          disabled={mutation.pending}
                          onClick={() => void revoke(i)}
                        >
                          Revoke
                          <span className={styles.visuallyHidden}> invitation to {i.email}</span>
                        </button>
                      </td>
                    </tr>
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
