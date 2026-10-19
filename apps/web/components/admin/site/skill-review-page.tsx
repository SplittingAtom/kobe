"use client";

import Link from "next/link";
import {
  claimVersion,
  getReview,
  getReviewDiff,
  releaseVersion,
  type ReviewDetail,
} from "../../../lib/admin/api/site/skill-review";
import { Button, PageHeader, Section } from "../../ui/console";
import { useSiteAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";
import { ReviewActions } from "./skill-review-actions";
import { ReviewDiff } from "./skill-review-diff";
import { ReviewEvidence } from "./skill-review-evidence";
import { STATE_LABELS, StateBadge } from "./skill-review-queue";

const ACTIONS: Readonly<Record<string, string>> = {
  submitted: "submitted it",
  claimed: "claimed it",
  unclaimed: "let go of it",
  commented: "commented",
  approved: "approved it",
  changes_requested: "requested changes",
  rejected: "rejected it",
  rejected_and_blocked: "rejected and blocked it",
};

/**
 * One Registry version's review (KOBE-334, SK23). It opens on the diff against the approved
 * version, then the evidence (scan, scorecards, capabilities, provenance, name hints), the
 * decision and the history. Only Site admins see Reject and block (SK22); the server checks
 * every action again.
 */
export function SkillReviewPage({ versionId }: { readonly versionId: string }) {
  const access = useSiteAccess();
  const mayBlock = access.siteRole === "admin" || access.siteRole === "owner";
  const detail = useResource(() => getReview(versionId));
  const diff = useResource(() => getReviewDiff(versionId));
  const mutation = useMutation();
  return (
    <>
      <p>
        <Link href="/admin/site/skill-review" className="underline">
          Back to the queue
        </Link>
      </p>
      <ResourceView state={detail.state} label="the version">
        {(d) => (
          <>
            <PageHeader
              title={`${d.skill.name} ${d.semver}`}
              description={
                d.previous
                  ? `A ${d.bump} update of the approved ${d.previous.semver}.`
                  : "A new skill: nothing of it is approved yet."
              }
            />
            <ClaimBar
              detail={d}
              userId={access.user.id}
              mayTakeOver={mayBlock}
              mutation={mutation}
              onChanged={detail.reload}
            />
            <MutationStatus error={mutation.error} notice={mutation.notice} />
            <Section title="Diff">
              <ResourceView state={diff.state} label="the diff">
                {(x) => <ReviewDiff diff={x} />}
              </ResourceView>
            </Section>
            <Section title="Evidence">
              <ReviewEvidence detail={d} />
            </Section>
            <ReviewActions
              detail={d}
              mayBlock={mayBlock}
              mutation={mutation}
              onChanged={detail.reload}
            />
            <History detail={d} />
          </>
        )}
      </ResourceView>
    </>
  );
}

function ClaimBar({
  detail,
  userId,
  mayTakeOver,
  mutation,
  onChanged,
}: {
  readonly detail: ReviewDetail;
  readonly userId: string;
  readonly mayTakeOver: boolean;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const open = detail.state === "submitted" || detail.state === "in_review";
  const mine = detail.claimedBy?.id === userId;
  const run = async (fn: () => ReturnType<typeof claimVersion>, notice: string) => {
    if (await mutation.run(fn, () => notice)) onChanged();
  };
  return (
    <p className="flex flex-wrap items-center gap-2">
      <StateBadge state={detail.state} />
      <span>
        Submitted by {detail.submittedBy?.name ?? "—"}, <DateTime value={detail.submittedAt} />
        {detail.claimedBy && `; claimed by ${mine ? "you" : detail.claimedBy.name}`}.
      </span>
      {open && !detail.claimedBy && (
        <Button
          disabled={mutation.pending}
          onClick={() => void run(() => claimVersion(detail.id), "Claimed: it is In review.")}
        >
          Claim
        </Button>
      )}
      {open && detail.claimedBy && (mine || mayTakeOver) && (
        <Button
          disabled={mutation.pending}
          onClick={() =>
            void run(() => releaseVersion(detail.id), "Released: it waits in the queue.")
          }
        >
          {mine ? "Let go" : "Release the claim"}
        </Button>
      )}
    </p>
  );
}

function History({ detail }: { readonly detail: ReviewDetail }) {
  return (
    <Section title="History">
      <ol className="list-decimal ps-6">
        {detail.events.map((e, i) => (
          <li key={i}>
            <DateTime value={e.at} /> {e.actor?.name ?? "Someone"} {ACTIONS[e.action] ?? e.action}
            {e.note && <q className="ms-1">{e.note}</q>}
          </li>
        ))}
      </ol>
      <p className="text-console-muted">
        State now: {STATE_LABELS[detail.state] ?? detail.state}
        {detail.selfApproved && " (approved by its submitter on a single-admin Site)"}
      </p>
    </Section>
  );
}
