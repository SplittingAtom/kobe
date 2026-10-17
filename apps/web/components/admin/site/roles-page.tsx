"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  listSiteRoles,
  setSiteRole,
  transferOwnership,
  type SiteRoleHolder,
} from "../../../lib/admin/api/site/roles";
import { listUsers, type SiteUser } from "../../../lib/admin/api/site/users";
import { canManageSiteRoles } from "../../../lib/admin/rules";
import {
  Badge,
  Button,
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
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { useSiteAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

interface RolesData {
  readonly holders: readonly SiteRoleHolder[];
  readonly users: readonly SiteUser[];
}

async function loadRoles(): Promise<ApiResult<RolesData>> {
  const [holders, users] = await Promise.all([listSiteRoles(), listUsers()]);
  if (!holders.ok) return holders;
  if (!users.ok) return users;
  return { ok: true, status: 200, data: { holders: holders.data, users: users.data } };
}

/** Site roles (spec D8): read by site admins; changed only by the Owner. */
export function RolesPage() {
  const access = useSiteAccess();
  const isOwner = canManageSiteRoles(access.siteRole);
  const { state, reload } = useResource(loadRoles);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const [grantTo, setGrantTo] = useState("");
  const [transferTo, setTransferTo] = useState("");

  async function revoke(holder: SiteRoleHolder, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Revoke Admin from ${holder.name}?`,
        description: "They become a User.",
        confirmLabel: "Revoke Admin",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => setSiteRole(holder.userId, "user"),
      () => `${holder.name} is now a User.`,
    );
    if (done) reload();
  }

  async function grant(e: FormEvent<HTMLFormElement>, users: readonly SiteUser[]) {
    e.preventDefault();
    const user = users.find((u) => u.id === grantTo);
    if (!user) return;
    const done = await mutation.run(
      () => setSiteRole(user.id, "admin"),
      () => `${user.name} is now an Admin.`,
    );
    if (done) {
      setGrantTo("");
      reload();
    }
  }

  async function transfer(e: FormEvent<HTMLFormElement>, users: readonly SiteUser[]) {
    e.preventDefault();
    const trigger = eventTrigger(e);
    const user = users.find((u) => u.id === transferTo);
    if (!user) return;
    const yes = await confirm(
      {
        title: `Make ${user.name} the Owner?`,
        description: "You become an Admin. Only they can undo this.",
        confirmLabel: "Transfer ownership",
      },
      trigger,
    );
    if (!yes) return;
    // Your own role changes: reload so the console reflects it.
    if (await mutation.run(() => transferOwnership(user.id))) window.location.reload();
  }

  return (
    <>
      <PageHeader
        title="Site roles"
        description={
          <>
            One Owner, any number of Admins; everyone else is a User. Site roles give no access to
            team content.
            {!isOwner && " Only the Owner grants or revokes Admin and transfers ownership."}
          </>
        }
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="site roles">
        {({ holders, users }) => {
          const active = users.filter((u) => u.deactivatedAt === null);
          const candidates = active.filter((u) => u.siteRole === "user");
          const successors = active.filter((u) => u.id !== access.user.id);
          return (
            <>
              <Table caption="Owner and Admins">
                <TableHead>
                  <TableRow>
                    <TableHeader>Name</TableHeader>
                    <TableHeader>Email</TableHeader>
                    <TableHeader>Role</TableHeader>
                    {isOwner && (
                      <TableHeader>
                        <span className="sr-only">Actions</span>
                      </TableHeader>
                    )}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {holders.map((h) => (
                    <TableRow key={h.userId}>
                      <TableRowHeader>{h.name}</TableRowHeader>
                      <TableCell>{h.email}</TableCell>
                      <TableCell>
                        {h.role === "owner" ? <Badge tone="accent">Owner</Badge> : "Admin"}
                      </TableCell>
                      {isOwner && (
                        <TableCell>
                          {h.role === "admin" && (
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={mutation.pending}
                              onClick={(e) => void revoke(h, eventTrigger(e))}
                            >
                              Revoke Admin
                              <span className="sr-only"> from {h.name}</span>
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {isOwner && (
                <>
                  <Section title="Grant Admin">
                    <form onSubmit={(e) => void grant(e, users)} aria-label="Grant Admin">
                      <FormRow className="mt-0">
                        <Field label="User">
                          <Select
                            required
                            value={grantTo}
                            onChange={(e) => setGrantTo(e.target.value)}
                          >
                            <option value="">Choose a user…</option>
                            {candidates.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.name} ({u.email})
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Button type="submit" variant="primary" disabled={mutation.pending}>
                          Make Admin
                        </Button>
                      </FormRow>
                    </form>
                  </Section>
                  <Section title="Transfer ownership">
                    <form onSubmit={(e) => void transfer(e, users)} aria-label="Transfer ownership">
                      <FormRow className="mt-0">
                        <Field label="New Owner">
                          <Select
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
                          </Select>
                        </Field>
                        <Button type="submit" variant="danger" disabled={mutation.pending}>
                          Transfer ownership
                        </Button>
                      </FormRow>
                    </form>
                  </Section>
                </>
              )}
            </>
          );
        }}
      </ResourceView>
      {confirmDialog}
    </>
  );
}
