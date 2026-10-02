"use client";

import { useState, type FormEvent } from "react";
import {
  createInstallInvite,
  listInstallInvites,
  resendInstallInvite,
  revokeInstallInvite,
  type InstallInvite,
  type InviteSent,
} from "../../../lib/admin/api/install/invites";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

function sentNotice(result: InviteSent): string {
  return result.emailSent
    ? `Invitation sent to ${result.invitation.email}.`
    : `Invitation created for ${result.invitation.email}, but the email could not be sent. Check SMTP, then use Resend.`;
}

/** Install invitations (spec D7; `/v1/install/invites`). Teams invite people separately. */
export function InstallInvitesPage() {
  const { state, reload } = useResource(listInstallInvites);
  const mutation = useMutation();
  const [email, setEmail] = useState("");

  async function onInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (await mutation.run(() => createInstallInvite(email.trim()), sentNotice)) {
      setEmail("");
      reload();
    }
  }

  async function resend(invite: InstallInvite) {
    if (await mutation.run(() => resendInstallInvite(invite.id), sentNotice)) reload();
  }

  async function revoke(invite: InstallInvite) {
    if (!confirmed(`Revoke the invitation to ${invite.email}? The link stops working.`)) return;
    const done = await mutation.run(
      () => revokeInstallInvite(invite.id),
      () => `Revoked the invitation to ${invite.email}.`,
    );
    if (done) reload();
  }

  return (
    <>
      <h1>Invitations</h1>
      <p className={styles.hint}>
        An invitation brings someone into Kobe. Team admins then invite them into their teams.
      </p>
      <form onSubmit={onInvite} className={styles.form} aria-label="Invite someone">
        <label>
          Email address
          <input
            type="email"
            name="email"
            required
            maxLength={254}
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <button type="submit" disabled={mutation.pending}>
          Send invitation
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
                <caption>Open invitations</caption>
                <thead>
                  <tr>
                    <th scope="col">Email</th>
                    <th scope="col">Invited by</th>
                    <th scope="col">Sent</th>
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
                      <td>{i.invitedBy.name}</td>
                      <td>
                        <DateTime value={i.createdAt} />
                      </td>
                      <td>
                        <DateTime value={i.expiresAt} />
                      </td>
                      <td>{i.status === "expired" ? "Expired" : "Pending"}</td>
                      <td>
                        <div className={styles.actions}>
                          <button
                            type="button"
                            disabled={mutation.pending}
                            onClick={() => void resend(i)}
                          >
                            Resend<span className={styles.visuallyHidden}> to {i.email}</span>
                          </button>
                          <button
                            type="button"
                            disabled={mutation.pending}
                            onClick={() => void revoke(i)}
                          >
                            Revoke
                            <span className={styles.visuallyHidden}> invitation to {i.email}</span>
                          </button>
                        </div>
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
