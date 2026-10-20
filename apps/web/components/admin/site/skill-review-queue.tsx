"use client";

import Link from "next/link";
import { useState } from "react";
import {
  QUEUE_FILTERS,
  listQueue,
  registryStatus,
  type Bump,
  type QueueFilter,
  type QueueItem,
} from "../../../lib/admin/api/site/skill-review";
import {
  Badge,
  EmptyState,
  Field,
  Notice,
  PageHeader,
  Section,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  type BadgeTone,
} from "../../ui/console";
import { DateTime, ResourceView } from "../parts";
import { useResource } from "../use-resource";

/** The review screen of one Registry version. */
export const reviewHref = (id: string) => `/admin/site/skill-review/${encodeURIComponent(id)}`;

export const FILTER_LABELS: Readonly<Record<QueueFilter, string>> = {
  open: "Waiting (submitted and in review)",
  submitted: "Submitted",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  retracted: "Withdrawn by their authors",
  all: "All",
};

export const STATE_LABELS: Readonly<Record<string, string>> = {
  submitted: "Submitted",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  deprecated: "Deprecated",
  withdrawn: "Withdrawn",
  revoked: "Revoked",
  retracted: "Withdrawn by its author",
};

const STATE_TONES: Readonly<Record<string, BadgeTone>> = {
  submitted: "accent",
  in_review: "running",
  changes_requested: "attention",
  approved: "done",
  rejected: "failed",
};

export const VERDICT_TONES: Readonly<Record<string, BadgeTone>> = {
  pass: "done",
  caution: "attention",
  block: "failed",
};

const BUMP_LABELS: Readonly<Record<Bump, string>> = {
  new: "new skill",
  major: "major",
  minor: "minor",
  patch: "patch",
  older: "older than approved",
};

export const NOT_READY_NOTICE =
  "The Registry is not ready: Approve stays off until a Site admin creates the Registry team (Skill Registry settings).";

export function StateBadge({ state }: { readonly state: string }) {
  return <Badge tone={STATE_TONES[state] ?? "neutral"}>{STATE_LABELS[state] ?? state}</Badge>;
}

/**
 * The Registry queue (KOBE-334, SK23): Submitted → In review → Changes requested → Approved /
 * Rejected. Each row shows the semver bump and the changed-file count against the approved
 * version, so small changes can be batched; a reviewer opens one to review it.
 */
export function SkillReviewQueuePage() {
  const [filter, setFilter] = useState<QueueFilter>("open");
  const status = useResource(() => registryStatus());
  return (
    <>
      <PageHeader
        title="Skill reviews"
        description="Every version submitted to the Site Skills Registry is reviewed by a person before it reaches the catalog. Claim a version, read its diff and evidence, then approve, request changes or reject it."
      />
      {status.state.status === "ready" && !status.state.data.ready && (
        <Notice tone="warn">{NOT_READY_NOTICE}</Notice>
      )}
      <Field label="Show">
        <Select value={filter} onChange={(e) => setFilter(e.target.value as QueueFilter)}>
          {QUEUE_FILTERS.map((f) => (
            <option key={f} value={f}>
              {FILTER_LABELS[f]}
            </option>
          ))}
        </Select>
      </Field>
      <Section title="Queue">
        <QueueTable key={filter} filter={filter} />
      </Section>
    </>
  );
}

function QueueTable({ filter }: { readonly filter: QueueFilter }) {
  const { state } = useResource(() => listQueue(filter));
  return (
    <ResourceView state={state} label="the queue">
      {({ items }) =>
        items.length === 0 ? (
          <EmptyState title="Nothing here." />
        ) : (
          <Table caption="Registry queue" hideCaption>
            <TableHead>
              <TableRow>
                <TableHeader>Skill</TableHeader>
                <TableHeader>Version</TableHeader>
                <TableHeader>Changed files</TableHeader>
                <TableHeader>Scan</TableHeader>
                <TableHeader>Submitted</TableHeader>
                <TableHeader>State</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((item) => (
                <QueueRow key={item.id} item={item} />
              ))}
            </TableBody>
          </Table>
        )
      }
    </ResourceView>
  );
}

function QueueRow({ item }: { readonly item: QueueItem }) {
  return (
    <TableRow>
      <TableRowHeader>
        <Link href={reviewHref(item.id)} className="underline">
          {item.skill.name}
        </Link>
      </TableRowHeader>
      <TableCell>
        {item.semver}{" "}
        <span className="text-console-muted">
          ({item.previous ? `from ${item.previous.semver}, ` : ""}
          {BUMP_LABELS[item.bump]})
        </span>
      </TableCell>
      <TableCell>{item.changedFiles ?? "—"}</TableCell>
      <TableCell>
        <Badge tone={VERDICT_TONES[item.verdict] ?? "neutral"}>{item.verdict}</Badge>
      </TableCell>
      <TableCell>
        {item.submittedBy?.name ?? "—"}, <DateTime value={item.submittedAt} />
      </TableCell>
      <TableCell>
        <StateBadge state={item.state} />
        {item.selfApproved && (
          <Badge tone="attention" className="ms-2">
            self-approved
          </Badge>
        )}
        {item.claimedBy && (
          <span className="ms-2 text-console-muted">claimed by {item.claimedBy.name}</span>
        )}
      </TableCell>
    </TableRow>
  );
}
