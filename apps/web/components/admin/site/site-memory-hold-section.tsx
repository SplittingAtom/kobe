"use client";

import { useState, type FormEvent } from "react";
import {
  decideSiteHold,
  listSiteHolds,
  requestSiteHold,
  requestSiteRelease,
  type HoldDecision,
  type SiteLegalHold,
} from "../../../lib/admin/api/site/legal-hold";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";
import { BUTTONS, DECISIONS, HoldStatus } from "./legal-hold-parts";

/** What placing and releasing a Site-wide hold does, in the confirmation's words. */
const SITE_DONE: Partial<Record<HoldDecision, string>> = {
  approve: "The Site-wide hold is in force: Site memories and their versions are kept.",
  "release/approve": "Released: Site memory purges and version pruning may resume.",
};

/**
 * Site-wide legal hold (v1.3 SM28, KOBE-647; `/v1/site/site-legal-hold`) on the legal hold page:
 * holds the Site's own memory, which belongs to no team. Same two-person rule as Workspace holds.
 */
export function SiteMemoryHoldSection() {
  const { state, reload } = useResource(listSiteHolds);
  const mutation = useMutation();
  const [releasing, setReleasing] = useState<SiteLegalHold | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  async function decide(
    hold: SiteLegalHold,
    decision: HoldDecision,
    label: string,
    trigger: HTMLElement | null,
  ) {
    const { verb, done, tone } = DECISIONS[decision];
    const yes = await confirm(
      { title: `${verb} the Site-wide legal hold?`, confirmLabel: label, tone },
      trigger,
    );
    if (!yes) return;
    if (
      await mutation.run(
        () => decideSiteHold(hold.id, decision),
        () => SITE_DONE[decision] ?? done,
      )
    )
      reload();
  }

  return (
    <Section title="Site memory (Site-wide hold)">
      <p className="mt-0 max-w-3xl text-sm text-console-muted">
        A Site-wide hold keeps the Site&apos;s own memories: no Site memory or earlier version is
        deleted or pruned while it is in force, even past the versions-kept limit, and changes to a
        Site memory&apos;s kind, tags, Policy flag or as-of date record the earlier values in the
        site audit log. Workspace holds above don&apos;t cover Site memory. Placing and releasing
        need a second site admin.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="Site-wide legal holds">
        {(data) => (
          <>
            <p>
              <Badge tone={data.active ? "running" : "neutral"}>
                {data.active ? "Site memory is held" : "Site memory is not held"}
              </Badge>
            </p>
            <SiteRequestForm
              soleAdmin={data.selfApprovalAllowed}
              mutation={mutation}
              onRequested={reload}
            />
            {releasing && (
              <SiteReleaseForm
                hold={releasing}
                mutation={mutation}
                onDone={() => {
                  setReleasing(null);
                  reload();
                }}
                onCancel={() => setReleasing(null)}
              />
            )}
            <SiteHoldTable
              holds={data.holds}
              pending={mutation.pending}
              onDecide={(hold, decision, label, trigger) =>
                void decide(hold, decision, label, trigger)
              }
              onRelease={setReleasing}
            />
          </>
        )}
      </ResourceView>
      {confirmDialog}
    </Section>
  );
}

function SiteRequestForm({
  soleAdmin,
  mutation,
  onRequested,
}: {
  readonly soleAdmin: boolean;
  readonly mutation: Mutation;
  readonly onRequested: () => void;
}) {
  const [reason, setReason] = useState("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => requestSiteHold(reason.trim()),
      () =>
        soleAdmin
          ? "Requested a Site-wide hold. You are the only site admin: you can place it yourself (it will be flagged)."
          : "Requested a Site-wide hold. A second site admin must place it.",
    );
    if (done) {
      setReason("");
      onRequested();
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label="Request a Site-wide legal hold" className="mb-4">
      <Field label="Reason for the Site-wide hold" className="mb-3 max-w-2xl">
        <Textarea
          required
          minLength={10}
          maxLength={2000}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" disabled={mutation.pending}>
        Request Site-wide hold
      </Button>
    </form>
  );
}

function SiteReleaseForm({
  hold,
  mutation,
  onDone,
  onCancel,
}: {
  readonly hold: SiteLegalHold;
  readonly mutation: Mutation;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => requestSiteRelease(hold.id, reason.trim()),
      () => "Release requested. The hold stays in force until a second site admin approves.",
    );
    if (done) onDone();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Ask to release the Site-wide hold" className="mb-4">
      <Field label="Why can the Site-wide hold end?" className="mb-3 max-w-2xl">
        <Textarea
          required
          minLength={10}
          maxLength={2000}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={mutation.pending}>
          Ask to release
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function SiteHoldTable({
  holds,
  pending,
  onDecide,
  onRelease,
}: {
  readonly holds: readonly SiteLegalHold[];
  readonly pending: boolean;
  readonly onDecide: (
    hold: SiteLegalHold,
    decision: HoldDecision,
    label: string,
    trigger: HTMLElement | null,
  ) => void;
  readonly onRelease: (hold: SiteLegalHold) => void;
}) {
  if (holds.length === 0) return <EmptyState title="No Site-wide holds yet." />;
  return (
    <Table caption="Site-wide holds" hideCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Requested by</TableHeader>
          <TableHeader>Reason</TableHeader>
          <TableHeader>Status</TableHeader>
          <TableHeader>
            <span className="sr-only">Actions</span>
          </TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {holds.map((hold) => (
          <TableRow key={hold.id}>
            <TableCell>
              {hold.requestedBy.name}
              <br />
              <span className="text-sm text-console-muted">
                <DateTime value={hold.requestedAt} />
              </span>
            </TableCell>
            <TableCell>{hold.reason}</TableCell>
            <TableCell>
              <HoldStatus hold={hold} />
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1.5">
                {BUTTONS.filter(([allowed]) => hold.actions[allowed]).map(
                  ([allowed, decision, label]) => (
                    <Button
                      key={allowed}
                      size="sm"
                      variant={
                        decision === "release" || DECISIONS[decision].tone === "primary"
                          ? "secondary"
                          : "danger"
                      }
                      disabled={pending}
                      onClick={(e) =>
                        decision === "release"
                          ? onRelease(hold)
                          : onDecide(hold, decision, label, eventTrigger(e))
                      }
                    >
                      {label}
                    </Button>
                  ),
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
