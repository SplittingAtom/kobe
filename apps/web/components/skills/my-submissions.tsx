"use client";

import {
  listMySubmissions,
  retractSubmission,
  type Submission,
} from "../../lib/skills/submissions-api";
import { Badge, Button, Section, eventTrigger, useConfirm, type BadgeTone } from "../ui/console";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";

const STATES: Readonly<Record<string, { label: string; tone: BadgeTone }>> = {
  submitted: { label: "Waiting for a reviewer", tone: "accent" },
  in_review: { label: "In review", tone: "running" },
  changes_requested: { label: "Changes requested", tone: "attention" },
  approved: { label: "In the Site catalog", tone: "done" },
  rejected: { label: "Rejected", tone: "failed" },
  retracted: { label: "Withdrawn", tone: "neutral" },
};

const OPEN = new Set(["submitted", "in_review", "changes_requested"]);

const NOTE_LABELS: Readonly<Record<string, string>> = {
  changes_requested: "Changes requested",
  rejected: "Rejected",
  rejected_and_blocked: "Rejected",
  approved: "Approved",
};

function Row({
  s,
  onWithdraw,
}: {
  readonly s: Submission;
  readonly onWithdraw: (s: Submission, trigger: HTMLElement | null) => void;
}) {
  const state = STATES[s.state] ?? { label: s.state, tone: "neutral" as const };
  return (
    <li className="mt-2">
      <strong>
        {s.name} {s.semver}
      </strong>{" "}
      <Badge tone={state.tone}>{state.label}</Badge>{" "}
      {s.selfApproved && (
        <Badge
          tone="attention"
          title="Approved on a single-admin Site by its submitter or confirming Team admin"
        >
          Self-approved
        </Badge>
      )}{" "}
      <span className="text-console-muted">
        submitted <DateTime value={s.submittedAt} />
      </span>
      {s.notes.length > 0 && (
        <ul className="list-disc ps-6">
          {s.notes.map((n, i) => (
            <li key={i}>
              {NOTE_LABELS[n.action] ?? n.action}, <DateTime value={n.at} />: <q>{n.note}</q>
            </li>
          ))}
        </ul>
      )}
      {OPEN.has(s.state) && (
        <Button size="sm" className="ms-2" onClick={(e) => onWithdraw(s, eventTrigger(e))}>
          Withdraw
        </Button>
      )}
      {s.state === "changes_requested" && (
        <p className="text-console-muted">
          Edit the skill in a draft, save a new version and promote it again.
        </p>
      )}
    </li>
  );
}

/**
 * The Workbench's view of the author's Site submissions (KOBE-334, SK23): each state and the
 * reviewer's note with every decision, so Request changes comes back to where skills are written.
 */
export function MySubmissions() {
  const { state, reload } = useResource(() => listMySubmissions());
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  async function withdraw(s: Submission, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Withdraw ${s.name} ${s.semver} from the Site Registry?`,
        description: "Reviewers stop reviewing it. A name never approved becomes free for others.",
        confirmLabel: "Withdraw",
      },
      trigger,
    );
    if (!yes) return;
    if (
      await mutation.run(
        () => retractSubmission(s.id),
        () => "Withdrawn.",
      )
    )
      reload();
  }
  return (
    <Section
      title="My Site submissions"
      description="Versions you promoted to the Site Skills Registry, and what reviewers said."
    >
      <ResourceView state={state} label="your submissions">
        {({ submissions }) =>
          submissions.length === 0 ? (
            <p>You haven&apos;t promoted a skill to the Site yet.</p>
          ) : (
            <ul className="list-none ps-0">
              {submissions.map((s) => (
                <Row key={s.id} s={s} onWithdraw={(x, t) => void withdraw(x, t)} />
              ))}
            </ul>
          )
        }
      </ResourceView>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {confirmDialog}
    </Section>
  );
}
