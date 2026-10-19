"use client";

import { listMySubmissions, type Submission } from "../../lib/skills/submissions-api";
import { Badge, Section, type BadgeTone } from "../ui/console";
import { DateTime, ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";

const STATES: Readonly<Record<string, { label: string; tone: BadgeTone }>> = {
  submitted: { label: "Waiting for a reviewer", tone: "accent" },
  in_review: { label: "In review", tone: "running" },
  changes_requested: { label: "Changes requested", tone: "attention" },
  approved: { label: "In the Site catalog", tone: "done" },
  rejected: { label: "Rejected", tone: "failed" },
};

const NOTE_LABELS: Readonly<Record<string, string>> = {
  changes_requested: "Changes requested",
  rejected: "Rejected",
  rejected_and_blocked: "Rejected",
  approved: "Approved",
};

function Row({ s }: { readonly s: Submission }) {
  const state = STATES[s.state] ?? { label: s.state, tone: "neutral" as const };
  return (
    <li className="mt-2">
      <strong>
        {s.name} {s.semver}
      </strong>{" "}
      <Badge tone={state.tone}>{state.label}</Badge>{" "}
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
  const { state } = useResource(() => listMySubmissions());
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
                <Row key={s.id} s={s} />
              ))}
            </ul>
          )
        }
      </ResourceView>
    </Section>
  );
}
