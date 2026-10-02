"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  listInstallRoles,
  setInstallRole,
  transferOwnership,
  type InstallRoleHolder,
} from "../../../lib/admin/api/install/roles";
import { listUsers, type InstallUser } from "../../../lib/admin/api/install/users";
import { canManageInstallRoles } from "../../../lib/admin/rules";
import { useInstallAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

interface RolesData {
  readonly holders: readonly InstallRoleHolder[];
  readonly users: readonly InstallUser[];
}

async function loadRoles(): Promise<ApiResult<RolesData>> {
  const [holders, users] = await Promise.all([listInstallRoles(), listUsers()]);
  if (!holders.ok) return holders;
  if (!users.ok) return users;
  return { ok: true, status: 200, data: { holders: holders.data, users: users.data } };
}

/** Install roles (spec D8): read by install admins; changed only by the Owner. */
export function RolesPage() {
  const access = useInstallAccess();
  const isOwner = canManageInstallRoles(access.installRole);
  const { state, reload } = useResource(loadRoles);
  const mutation = useMutation();
  const [grantTo, setGrantTo] = useState("");
  const [transferTo, setTransferTo] = useState("");

  async function revoke(holder: InstallRoleHolder) {
    if (!confirmed(`Revoke Admin from ${holder.name}? They become a User.`)) return;
    const done = await mutation.run(
      () => setInstallRole(holder.userId, "user"),
      () => `${holder.name} is now a User.`,
    );
    if (done) reload();
  }

  async function grant(e: FormEvent<HTMLFormElement>, users: readonly InstallUser[]) {
    e.preventDefault();
    const user = users.find((u) => u.id === grantTo);
    if (!user) return;
    const done = await mutation.run(
      () => setInstallRole(user.id, "admin"),
      () => `${user.name} is now an Admin.`,
    );
    if (done) {
      setGrantTo("");
      reload();
    }
  }

  async function transfer(e: FormEvent<HTMLFormElement>, users: readonly InstallUser[]) {
    e.preventDefault();
    const user = users.find((u) => u.id === transferTo);
    if (!user) return;
    if (!confirmed(`Make ${user.name} the Owner? You become an Admin. Only they can undo this.`)) {
      return;
    }
    // Your own role changes: reload so the console reflects it.
    if (await mutation.run(() => transferOwnership(user.id))) window.location.reload();
  }

  return (
    <>
      <h1>Install roles</h1>
      <p className={styles.hint}>
        One Owner, any number of Admins; everyone else is a User. Install roles give no access to
        team content.
        {!isOwner && " Only the Owner grants or revokes Admin and transfers ownership."}
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="install roles">
        {({ holders, users }) => {
          const active = users.filter((u) => u.deactivatedAt === null);
          const candidates = active.filter((u) => u.installRole === "user");
          const successors = active.filter((u) => u.id !== access.user.id);
          return (
            <>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption>Owner and Admins</caption>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Email</th>
                      <th scope="col">Role</th>
                      {isOwner && (
                        <th scope="col">
                          <span className={styles.visuallyHidden}>Actions</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {holders.map((h) => (
                      <tr key={h.userId}>
                        <th scope="row">{h.name}</th>
                        <td>{h.email}</td>
                        <td>{h.role === "owner" ? "Owner" : "Admin"}</td>
                        {isOwner && (
                          <td>
                            {h.role === "admin" && (
                              <button
                                type="button"
                                disabled={mutation.pending}
                                onClick={() => void revoke(h)}
                              >
                                Revoke Admin
                                <span className={styles.visuallyHidden}> from {h.name}</span>
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {isOwner && (
                <>
                  <h2>Grant Admin</h2>
                  <form
                    onSubmit={(e) => void grant(e, users)}
                    className={styles.form}
                    aria-label="Grant Admin"
                  >
                    <label>
                      User
                      <select required value={grantTo} onChange={(e) => setGrantTo(e.target.value)}>
                        <option value="">Choose a user…</option>
                        {candidates.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name} ({u.email})
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="submit" disabled={mutation.pending}>
                      Make Admin
                    </button>
                  </form>
                  <h2>Transfer ownership</h2>
                  <form
                    onSubmit={(e) => void transfer(e, users)}
                    className={styles.form}
                    aria-label="Transfer ownership"
                  >
                    <label>
                      New Owner
                      <select
                        required
                        value={transferTo}
                        onChange={(e) => setTransferTo(e.target.value)}
                      >
                        <option value="">Choose a user…</option>
                        {successors.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name} ({u.email})
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="submit" disabled={mutation.pending}>
                      Transfer ownership
                    </button>
                  </form>
                </>
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
