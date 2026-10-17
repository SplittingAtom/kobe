"use client";

import { useState, type FormEvent } from "react";
import {
  createSiteInvite,
  listSiteInvites,
  resendSiteInvite,
  revokeSiteInvite,
  type SiteInvite,
  type InviteSent,
} from "../../../lib/admin/api/site/invites";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  FormRow,
  PageHeader,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  TextInput,
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useFocusAfterRemoval } from "../use-focus-after-removal";
import { useMutation, useResource } from "../use-resource";

/** The list's heading: focus lands here when a revoke empties the list. */
const HEADING = "open-invitations";

function sentNotice(result: InviteSent): string {
  return result.emailSent
    ? `Invitation sent to ${result.invitation.email}.`
    : `Invitation created for ${result.invitation.email}, but the email could not be sent. Check SMTP, then use Resend.`;
}

/** Site invitations (spec D7; `/v1/site/invites`). Teams invite people separately. */
export function SiteInvitesPage() {
  const { state, reload } = useResource(listSiteInvites);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const [email, setEmail] = useState("");
  const focus = useFocusAfterRemoval(
    state.status === "ready" ? state.data.map((i) => i.id) : null,
    HEADING,
  );

  async function onInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (await mutation.run(() => createSiteInvite(email.trim()), sentNotice)) {
      setEmail("");
      reload();
    }
  }

  async function resend(invite: SiteInvite) {
    if (await mutation.run(() => resendSiteInvite(invite.id), sentNotice)) reload();
  }

  async function revoke(invite: SiteInvite, index: number, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Revoke the invitation to ${invite.email}?`,
        description: "The link stops working.",
        confirmLabel: "Revoke",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => revokeSiteInvite(invite.id),
      () => `Revoked the invitation to ${invite.email}.`,
    );
    if (done) {
      focus.removed(invite.id, index);
      reload();
    }
  }

  return (
    <>
      <PageHeader
        title="Invitations"
        description="An invitation brings someone into Kobe. Team admins then invite them into their teams."
      />
      <form onSubmit={onInvite} aria-label="Invite someone">
        <FormRow>
          <Field label="Email address">
            <TextInput
              type="email"
              name="email"
              required
              maxLength={254}
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={mutation.pending}>
            Send invitation
          </Button>
        </FormRow>
      </form>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <Section id={HEADING} title="Open invitations">
        <ResourceView state={state} label="invitations">
          {(invites) =>
            invites.length === 0 ? (
              <EmptyState title="No open invitations." />
            ) : (
              <div ref={focus.container}>
                <Table caption="Open invitations" hideCaption>
                  <TableHead>
                    <TableRow>
                      <TableHeader>Email</TableHeader>
                      <TableHeader>Invited by</TableHeader>
                      <TableHeader>Sent</TableHeader>
                      <TableHeader>Expires</TableHeader>
                      <TableHeader>Status</TableHeader>
                      <TableHeader>
                        <span className="sr-only">Actions</span>
                      </TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {invites.map((i, index) => (
                      <TableRow key={i.id}>
                        <TableRowHeader>{i.email}</TableRowHeader>
                        <TableCell>{i.invitedBy.name}</TableCell>
                        <TableCell>
                          <DateTime value={i.createdAt} />
                        </TableCell>
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
                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              size="sm"
                              disabled={mutation.pending}
                              onClick={() => void resend(i)}
                            >
                              Resend<span className="sr-only"> to {i.email}</span>
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              data-remove=""
                              disabled={mutation.pending}
                              onClick={(e) => void revoke(i, index, eventTrigger(e))}
                            >
                              Revoke
                              <span className="sr-only"> invitation to {i.email}</span>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )
          }
        </ResourceView>
      </Section>
      {confirmDialog}
    </>
  );
}
