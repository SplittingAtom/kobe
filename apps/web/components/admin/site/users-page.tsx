"use client";

import Link from "next/link";
import {
  setUserActive,
  listUsers,
  type DeactivationResult,
  type SiteUser,
} from "../../../lib/admin/api/site/users";
import { consoleHref } from "../../../lib/admin/nav/registry";
import { canChangeActivation } from "../../../lib/admin/rules";
import { useSiteAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

const ROLE = { owner: "Owner", admin: "Admin", user: "User" } as const;

function deactivationNotice(user: SiteUser, result: DeactivationResult): string {
  const parts = [`${user.name} is deactivated and signed out everywhere.`];
  const orphaned = result.teamsWithoutActiveAdmin ?? [];
  if (orphaned.length > 0) {
    parts.push(
      `These teams now have no active team admin: ${orphaned.map((t) => t.name).join(", ")}.`,
    );
  }
  if (result.incompleteSteps.length > 0) {
    parts.push(
      `Some follow-up steps failed (${result.incompleteSteps.join(", ")}); the deactivation still holds.`,
    );
  }
  return parts.join(" ");
}

/** Site users (spec D7; `/v1/site/users`). */
export function UsersPage() {
  const access = useSiteAccess();
  const { state, reload } = useResource(listUsers);
  const mutation = useMutation();
  const me = { userId: access.user.id, role: access.siteRole };

  async function toggle(user: SiteUser) {
    const activate = user.deactivatedAt !== null;
    const question = activate
      ? `Reactivate ${user.name}? They can sign in again and get their teams back.`
      : `Deactivate ${user.name}? Every session ends now and they can't sign in until reactivated.`;
    if (!confirmed(question)) return;
    const done = await mutation.run(
      () => setUserActive(user.id, activate),
      (result) => (activate ? `${user.name} can sign in again.` : deactivationNotice(user, result)),
    );
    if (done) reload();
  }

  return (
    <>
      <h1>Users</h1>
      <p className={styles.hint}>
        People join Kobe by invitation.{" "}
        <Link href={`${consoleHref("site")}/invites`}>Invite someone</Link>.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="users">
        {(users) => (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>{users.length === 1 ? "1 user" : `${users.length} users`}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Site role</th>
                  <th scope="col">2FA</th>
                  <th scope="col">Status</th>
                  <th scope="col">Joined</th>
                  <th scope="col">
                    <span className={styles.visuallyHidden}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <th scope="row">{u.name}</th>
                    <td>{u.email}</td>
                    <td>{ROLE[u.siteRole]}</td>
                    <td>{u.twoFactorEnabled ? "On" : "Off"}</td>
                    <td>{u.deactivatedAt ? "Deactivated" : "Active"}</td>
                    <td>
                      <DateTime value={u.createdAt} />
                    </td>
                    <td>
                      {canChangeActivation(me, u) && (
                        <button
                          type="button"
                          disabled={mutation.pending}
                          onClick={() => void toggle(u)}
                        >
                          {u.deactivatedAt ? "Reactivate" : "Deactivate"}
                          <span className={styles.visuallyHidden}> {u.name}</span>
                        </button>
                      )}
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
