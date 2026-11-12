"use client";

import {
  LINKED_VIA_LABEL,
  listMySsoLinks,
  unlinkMySso,
  type SsoLink,
} from "../../lib/admin/api/site/sso-links";
import { ErrorNotice, MutationStatus } from "../admin/error-notice";
import { DateTime } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
import {
  Button,
  EmptyState,
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
} from "../ui/console";

/**
 * My area, Sign-in methods (KOBE-630, spec sso-oidc-scim §6): the organization sign-ins
 * (single sign-on identities) linked to this account, with Unlink. Unlinking ends the sessions
 * made through that sign-in; the server refuses it when it is the account's only way in.
 */
export function MySignInMethodsPage() {
  const { state, reload } = useResource(listMySsoLinks);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();

  async function unlink(link: SsoLink, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Unlink ${link.providerName}?`,
        description:
          "You can no longer sign in with it, and sessions signed in with it end now. Your password and passkeys stay.",
        confirmLabel: "Unlink",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => unlinkMySso(link.providerId),
      () => `${link.providerName} is unlinked.`,
    );
    if (done) reload();
  }

  const off = state.status === "error" && state.error.status === 404;
  return (
    <>
      <PageHeader
        title="Sign-in methods"
        description="Your organization's sign-ins linked to this Kobe account. To link one, sign in with it once, then sign in here with your password or passkey within 10 minutes and confirm."
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {state.status === "loading" && <p role="status">Loading sign-in methods…</p>}
      {state.status === "error" &&
        (off ? (
          <EmptyState title="Single sign-on is not set up on this site." />
        ) : (
          <ErrorNotice error={state.error} />
        ))}
      {state.status === "ready" &&
        (state.data.length === 0 ? (
          <EmptyState title="No organization sign-in is linked to this account." />
        ) : (
          <Table caption="Linked organization sign-ins">
            <TableHead>
              <TableRow>
                <TableHeader>Provider</TableHeader>
                <TableHeader>How</TableHeader>
                <TableHeader>Linked</TableHeader>
                <TableHeader>Last sign-in</TableHeader>
                <TableHeader>
                  <span className="sr-only">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {state.data.map((link) => (
                <TableRow key={link.providerId}>
                  <TableRowHeader>{link.providerName}</TableRowHeader>
                  <TableCell>{LINKED_VIA_LABEL[link.linkedVia]}</TableCell>
                  <TableCell>
                    <DateTime value={link.linkedAt} />
                  </TableCell>
                  <TableCell>
                    {link.lastSignInAt ? <DateTime value={link.lastSignInAt} /> : "Never"}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={mutation.pending}
                      onClick={(e) => void unlink(link, eventTrigger(e))}
                    >
                      Unlink<span className="sr-only"> {link.providerName}</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
      {confirmDialog}
    </>
  );
}
