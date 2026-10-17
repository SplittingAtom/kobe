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
import {
  Badge,
  Button,
  PageHeader,
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
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

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
  const [confirm, confirmDialog] = useConfirm();
  const me = { userId: access.user.id, role: access.siteRole };

  async function toggle(user: SiteUser, trigger: HTMLElement | null) {
    const activate = user.deactivatedAt !== null;
    const yes = await confirm(
      activate
        ? {
            title: `Reactivate ${user.name}?`,
            description: "They can sign in again and get their teams back.",
            confirmLabel: "Reactivate",
            tone: "primary",
          }
        : {
            title: `Deactivate ${user.name}?`,
            description: "Every session ends now and they can't sign in until reactivated.",
            confirmLabel: "Deactivate",
          },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => setUserActive(user.id, activate),
      (result) => (activate ? `${user.name} can sign in again.` : deactivationNotice(user, result)),
    );
    if (done) reload();
  }

  return (
    <>
      <PageHeader
        title="Users"
        description={
          <>
            People join Kobe by invitation.{" "}
            <Link href={`${consoleHref("site")}/invites`}>Invite someone</Link>.
          </>
        }
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="users">
        {(users) => (
          <Table caption={users.length === 1 ? "1 user" : `${users.length} users`}>
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Email</TableHeader>
                <TableHeader>Site role</TableHeader>
                <TableHeader>2FA</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>Joined</TableHeader>
                <TableHeader>
                  <span className="sr-only">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableRowHeader>{u.name}</TableRowHeader>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>{ROLE[u.siteRole]}</TableCell>
                  <TableCell>{u.twoFactorEnabled ? "On" : "Off"}</TableCell>
                  <TableCell>
                    {u.deactivatedAt ? <Badge tone="failed">Deactivated</Badge> : "Active"}
                  </TableCell>
                  <TableCell>
                    <DateTime value={u.createdAt} />
                  </TableCell>
                  <TableCell>
                    {canChangeActivation(me, u) && (
                      <Button
                        size="sm"
                        variant={u.deactivatedAt ? "secondary" : "danger"}
                        disabled={mutation.pending}
                        onClick={(e) => void toggle(u, eventTrigger(e))}
                      >
                        {u.deactivatedAt ? "Reactivate" : "Deactivate"}
                        <span className="sr-only"> {u.name}</span>
                      </Button>
                    )}
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
