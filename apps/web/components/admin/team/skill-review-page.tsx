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
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

const FILTERS: readonly ReviewFilter[] = ["pending", "approved", "rejected"];

/**
 * Skill review (spec D22; `/v1/team/skill-review`, KOBE-80): scanned versions of the team's
 * skills waiting for a team admin, flagged ones first, and the switch that leaves members'
 * personal skills out of the team's runs. Only approved versions are usable.
 */
export function SkillReviewPage() {
  return (
    <>
      <h1>Skill review</h1>
      <p className={styles.hint}>
        Every new version of a team skill is scanned when it is uploaded and stays unusable until a
        team admin approves it. The scan is a heuristic that flags network calls, pipes into a
        shell, package installs, obfuscation and secret-shaped strings: read the findings, and the
        skill, before approving. Rejecting an approved version takes it out of use again.
      </p>
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
    <section aria-labelledby="personal-skills-heading">
      <h2 id="personal-skills-heading">Personal skills</h2>
      <ResourceView state={state} label="the personal skills setting">
        {(disabled) => (
          <>
            <label>
              <input
                type="checkbox"
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
              />{" "}
              Disable personal skills in this team
            </label>
            <p className={styles.hint}>
              Members&apos; own skills are then left out of their runs here (they see a notice that
              they were omitted). They keep them in other teams. Team skills are not affected.
            </p>
            <MutationStatus error={mutation.error} notice={mutation.notice} />
          </>
        )}
      </ResourceView>
    </section>
  );
}

function ReviewQueue() {
  const teamId = useTeamAccess().team.id;
  const [filter, setFilter] = useState<ReviewFilter>("pending");
  return (
    <section aria-labelledby="queue-heading">
      <h2 id="queue-heading">Versions</h2>
      <div role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f[0]?.toUpperCase()}
            {f.slice(1)}
          </button>
        ))}
      </div>
      {/* Keyed by filter: switching it loads a fresh list. */}
      <ReviewList key={filter} teamId={teamId} filter={filter} />
    </section>
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

  async function decide(review: SkillReview, decision: "approved" | "rejected") {
    if (
      decision === "approved" &&
      review.flagged &&
      !confirmed(
        `${review.slug} v${review.version} was flagged by the scan (${review.findings.length} finding${review.findings.length === 1 ? "" : "s"}). Approve it anyway?`,
      )
    ) {
      return;
    }
    const done = await mutation.run(
      () => decideSkillReview(teamId, review, decision),
      () => `${review.slug} v${review.version} ${decision}.`,
    );
    if (done) reload();
  }

  return (
    <>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="skill versions">
        {(reviews) =>
          reviews.length === 0 ? (
            <p>No {filter} skill versions.</p>
          ) : (
            <ul>
              {reviews.map((r) => (
                <li key={`${r.skillId}:${r.version}`}>
                  <ReviewItem
                    review={r}
                    busy={mutation.pending}
                    onDecide={(d) => void decide(r, d)}
                  />
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>
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
  readonly onDecide: (decision: "approved" | "rejected") => void;
}) {
  return (
    <article aria-label={`${review.slug} version ${review.version}`}>
      <h3>
        {review.slug} v{review.version} {review.scope === "personal" && <em>(personal skill)</em>}{" "}
        {review.flagged && <strong>Flagged: {review.findings.length}</strong>}
        {review.blocked && <strong>Blocklisted</strong>}{" "}
        {review.unscanned && <strong>Not scanned yet</strong>}
      </h3>
      <p className={styles.hint}>
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
        <ul aria-label="Findings">
          {review.findings.map((f) => (
            <li key={`${f.file}:${f.line}:${f.category}`}>
              <strong>{f.category}</strong> ({f.rule}) in {f.file}:{f.line}:{" "}
              <code>{f.excerpt}</code>
            </li>
          ))}
        </ul>
      )}
      <p>
        {review.status !== "approved" && (
          <button type="button" disabled={busy} onClick={() => onDecide("approved")}>
            Approve
          </button>
        )}{" "}
        {review.status !== "rejected" && (
          <button type="button" disabled={busy} onClick={() => onDecide("rejected")}>
            Reject
          </button>
        )}
      </p>
    </article>
  );
}
