"use client";

import Link from "next/link";
import { useState } from "react";
import { listSsoProviders } from "../../../lib/admin/api/site/sso";
import {
  purgePortableMemory,
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
import { UserSsoLinks } from "./user-sso-links";

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
  // Single sign-on links (KOBE-630): only while SSO is on (the providers list answers 404 when off).
  const sso = useResource(listSsoProviders);
  const [ssoUserId, setSsoUserId] = useState<string | null>(null);

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

  async function purgeMemories(user: SiteUser, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Purge ${user.name}'s personal memories?`,
        description:
          "Their portable memories (preferences that follow them across workspaces) are deleted for good. Reactivating them later won't bring these back.",
        confirmLabel: "Purge memories",
      },
      trigger,
    );
    if (!yes) return;
    await mutation.run(
      () => purgePortableMemory(user.id),
      (result) =>
        result.kept > 0
          ? `Purged ${result.purged} of ${user.name}'s memories; ${result.kept} stay while a workspace legal hold covers a run that used them.`
          : `Purged ${result.purged} of ${user.name}'s memories.`,
    );
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
                    {sso.state.status === "ready" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-pressed={ssoUserId === u.id}
                        onClick={() => setSsoUserId(ssoUserId === u.id ? null : u.id)}
                      >
                        Single sign-on<span className="sr-only"> {u.name}</span>
                      </Button>
                    )}{" "}
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
                    )}{" "}
                    {u.deactivatedAt !== null && canChangeActivation(me, u) && (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={mutation.pending}
                        onClick={(e) => void purgeMemories(u, eventTrigger(e))}
                      >
                        Purge memories<span className="sr-only"> {u.name}</span>
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ResourceView>
      {sso.state.status === "ready" &&
        state.status === "ready" &&
        (() => {
          const selected = state.data.find((u) => u.id === ssoUserId);
          return selected ? (
            <UserSsoLinks key={selected.id} user={selected} providers={sso.state.data} />
          ) : null;
        })()}
      {confirmDialog}
    </>
  );
}
