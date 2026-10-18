"use client";

import { useState } from "react";
import {
  decideSkillReview,
  getPersonalSkillsDisabled,
  listSkillReviews,
  putPersonalSkillsDisabled,
  type ReviewFilter,
  type SkillReview,
} from "../../../lib/admin/api/team/skill-review";
import { TEAM_SKILL_RULE } from "../../../lib/admin/skills/reach";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  PageHeader,
  Section,
  useConfirm,
  eventTrigger,
} from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

const HINT = "m-0 my-1 text-sm text-console-muted";

const FILTERS: readonly ReviewFilter[] = ["pending", "approved", "rejected"];

/**
 * Skill review (spec D22; `/v1/team/skill-review`, KOBE-80): scanned versions of the team's
 * skills waiting for a team admin, flagged ones first, and the switch that leaves members'
 * personal skills out of the team's runs. Only approved versions are usable.
 */
export function SkillReviewPage() {
  return (
    <>
      <PageHeader
        title="Skill review"
        description={`Every new version of a team skill is scanned when it is uploaded and stays unusable until a team admin approves it. The scan is a heuristic that flags network calls, pipes into a shell, package installs, obfuscation and secret-shaped strings: read the findings, and the skill, before approving. Rejecting an approved version takes it out of use again. ${TEAM_SKILL_RULE}`}
      />
      <PersonalSkillsSwitch />
      <ReviewQueue />
    </>
  );
}

function PersonalSkillsSwitch() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => getPersonalSkillsDisabled(teamId));
  const mutation = useMutation();
  return (
    <Section id="personal-skills-heading" title="Personal skills">
      <ResourceView state={state} label="the personal skills setting">
        {(disabled) => (
          <>
            <Checkbox
              label="Disable personal skills in this team"
              hint="Members' own skills are then left out of their runs here (they see a notice that they were omitted). They keep them in other teams. Team skills are not affected."
              checked={disabled}
              disabled={mutation.pending}
              onChange={async (e) => {
                const next = e.target.checked;
                const done = await mutation.run(
                  () => putPersonalSkillsDisabled(teamId, next),
                  (value) =>
                    value
                      ? "Personal skills are off for this team."
                      : "Personal skills are on for this team.",
                );
                if (done) reload();
              }}
            />
            <MutationStatus error={mutation.error} notice={mutation.notice} />
          </>
        )}
      </ResourceView>
    </Section>
  );
}

function ReviewQueue() {
  const teamId = useTeamAccess().team.id;
  const [filter, setFilter] = useState<ReviewFilter>("pending");
  return (
    <Section id="queue-heading" title="Versions">
      <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "primary" : "secondary"}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f[0]?.toUpperCase()}
            {f.slice(1)}
          </Button>
        ))}
      </div>
      {/* Keyed by filter: switching it loads a fresh list. */}
      <ReviewList key={filter} teamId={teamId} filter={filter} />
    </Section>
  );
}

function ReviewList({
  teamId,
  filter,
}: {
  readonly teamId: string;
  readonly filter: ReviewFilter;
}) {
  const { state, reload } = useResource(() => listSkillReviews(teamId, filter));
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();

  async function decide(
    review: SkillReview,
    decision: "approved" | "rejected",
    trigger: HTMLElement | null,
    reason: string,
  ) {
    // Approving over findings is an explicit acknowledgement (KOBE-312): the dialog is it, and it
    // covers exactly the findings shown (their digest; the server refuses if they changed).
    const findings = `${review.findings.length} finding${review.findings.length === 1 ? "" : "s"}`;
    const acknowledged =
      decision === "approved" &&
      review.verdict !== "pass" &&
      (await confirm(
        {
          title: `Approve ${review.slug} v${review.semver} anyway?`,
          description:
            review.verdict === "block"
              ? `The scan blocks it (${findings}). Only a Site admin can approve it, with a reason; the override is audited.`
              : `It was flagged by the scan (${findings}). Approving acknowledges you read them.`,
          confirmLabel: "Approve anyway",
        },
        trigger,
      ));
    if (decision === "approved" && review.verdict !== "pass" && !acknowledged) return;
    const done = await mutation.run(
      () =>
        decideSkillReview(teamId, review, decision, {
          ...(acknowledged ? { acknowledgedFindings: review.findingsDigest } : {}),
          ...(reason.trim() ? { note: reason.trim() } : {}),
        }),
      () => `${review.slug} v${review.semver} ${decision}.`,
    );
    if (done) reload();
  }

  return (
    <>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="skill versions">
        {(reviews) =>
          reviews.length === 0 ? (
            <EmptyState className="mt-3" title={`No ${filter} skill versions.`} />
          ) : (
            <ul className="m-0 mt-3 grid list-none gap-3 p-0">
              {reviews.map((r) => (
                <li key={`${r.skillId}:${r.version}`}>
                  <ReviewItem
                    review={r}
                    busy={mutation.pending}
                    onDecide={(d, trigger, reason) => void decide(r, d, trigger, reason)}
                  />
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>
      {confirmDialog}
    </>
  );
}

function ReviewItem({
  review,
  busy,
  onDecide,
}: {
  readonly review: SkillReview;
  readonly busy: boolean;
  readonly onDecide: (
    decision: "approved" | "rejected",
    trigger: HTMLElement | null,
    reason: string,
  ) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <article
      aria-label={`${review.slug} version ${review.semver}`}
      className="box-border rounded-lg border border-console-border bg-console-bg p-3"
    >
      <h3 className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold">
        <span>
          {review.slug} v{review.semver}
        </span>
        {review.scope === "personal" && <em className="font-normal">(personal skill)</em>}
        {review.verdict === "caution" && (
          <Badge tone="attention">Caution: {review.findings.length}</Badge>
        )}
        {review.verdict === "block" && <Badge tone="failed">Blocked by scan</Badge>}
        {review.blocked && <Badge tone="failed">Blocklisted</Badge>}
        {review.unscanned && <Badge>Not scanned yet</Badge>}
      </h3>
      <p className={HINT}>
        Scanned <DateTime value={review.scannedAt} />. {review.scripts.length} script
        {review.scripts.length === 1 ? "" : "s"}
        {review.skipped.length > 0 ? `, ${review.skipped.length} file(s) not scanned` : ""}.
        {review.reviewedAt !== null && (
          <>
            {" "}
            Decided <DateTime value={review.reviewedAt} />.
          </>
        )}
      </p>
      {review.findings.length > 0 && (
        <ul aria-label="Findings" className="m-0 my-2 ps-5">
          {review.findings.map((f) => (
            <li key={`${f.file}:${f.line}:${f.category}`}>
              <strong>{f.category}</strong> ({f.rule}) in {f.file}:{f.line}:{" "}
              <code className="break-all">{f.excerpt}</code>
            </li>
          ))}
        </ul>
      )}
      {review.verdict === "block" && review.status !== "approved" && (
        <label className="mt-2 block text-sm">
          Reason for a Site admin override (audited)
          <textarea
            className="mt-1 block w-full rounded border border-console-border bg-console-bg p-1"
            value={reason}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {review.status !== "approved" && (
          <Button
            size="sm"
            disabled={busy}
            onClick={(e) => onDecide("approved", eventTrigger(e), reason)}
          >
            Approve
          </Button>
        )}
        {review.status !== "rejected" && (
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={(e) => onDecide("rejected", eventTrigger(e), reason)}
          >
            Reject
          </Button>
        )}
      </div>
    </article>
  );
}
