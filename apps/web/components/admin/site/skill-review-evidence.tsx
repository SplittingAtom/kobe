"use client";

import {
  acknowledgeFinding,
  cancelRerun,
  rerunEvals,
  type ReviewDetail,
  type ExternalScanState,
  type ReviewFinding,
} from "../../../lib/admin/api/site/skill-review";
import { visibleParts } from "../../../lib/admin/visible-text";
import {
  Badge,
  Button,
  EmptyState,
  Notice,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/console";
import { DateTime } from "../parts";
import type { Mutation } from "../use-resource";
import { VERDICT_TONES } from "./skill-review-queue";

const percent = (v: unknown) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");
const signed = (v: unknown) =>
  typeof v === "number" ? `${v >= 0 ? "+" : ""}${Math.round(v * 100)} points` : "—";

/** The numbers a scorecard carries (the catalog card's, SK16): never cases or transcripts. */
const ROWS: readonly (readonly [string, string, (v: unknown) => string])[] = [
  ["cases", "Cases", (v) => (typeof v === "number" ? String(v) : "—")],
  [
    "negativeTriggerCases",
    "Negative trigger cases",
    (v) => (typeof v === "number" ? String(v) : "—"),
  ],
  ["passRateWith", "Pass rate with the skill", percent],
  ["passRateWithout", "Pass rate without it", percent],
  ["lift", "Lift", signed],
  ["triggerPrecision", "Trigger precision", percent],
  ["triggerRecall", "Trigger recall", percent],
  ["costUsd", "Cost", (v) => (typeof v === "number" ? `$${v.toFixed(2)}` : "—")],
];

function Scorecard({ card }: { readonly card: Record<string, unknown> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
      {ROWS.filter(([key]) => key in card).map(([key, label, show]) => (
        <div key={key} className="contents">
          <dt className="text-console-muted">{label}</dt>
          <dd className="m-0">{show(card[key])}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The evidence beside the diff (SK23): scan verdict and findings, the scorecards, capabilities
 * against the site egress ceiling, provenance and similar-name hints.
 */
const RERUN_STATES: Readonly<Record<string, string>> = {
  queued: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  budget_stopped: "stopped by the Registry team's budget",
};

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

/**
 * Re-run evals (KOBE-335) and every re-run so far (review-335 M3): who started it, how it ended,
 * its numbers; the one whose card counts, and earlier ones that scored lower, are marked.
 */
function RerunControl({
  detail,
  open,
  mutation,
  onChanged,
}: {
  readonly detail: ReviewDetail;
  readonly open: boolean;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const runs = detail.reruns;
  const running = runs.some((r) => r.status === "queued" || r.status === "running");
  const run = async (fn: () => ReturnType<typeof rerunEvals>, notice: string) => {
    if (await mutation.run(fn, () => notice)) onChanged();
  };
  return (
    <div className="mt-2">
      {runs.length > 0 && (
        <Table caption="Re-runs" hideCaption>
          <TableHead>
            <TableRow>
              <TableHeader>Started</TableHeader>
              <TableHeader>By</TableHeader>
              <TableHeader>Outcome</TableHeader>
              <TableHeader>Pass rate</TableHeader>
              <TableHeader>
                <span className="sr-only">Actions</span>
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.evalRunId}>
                <TableCell>
                  <DateTime value={r.startedAt} compact />
                </TableCell>
                <TableCell>{r.startedBy?.name ?? "—"}</TableCell>
                <TableCell>
                  {RERUN_STATES[r.status] ?? r.status}
                  {r.cancelledBy && ` by ${r.cancelledBy.name}`}
                  {r.progress &&
                    r.status !== "completed" &&
                    ` (${r.progress.done} of ${r.progress.total})`}
                  {r.current && (
                    <Badge tone="done" className="ms-2">
                      the authoritative card
                    </Badge>
                  )}
                  {r.lowerThanCurrent && (
                    <Badge tone="attention" className="ms-2">
                      scored lower
                    </Badge>
                  )}
                </TableCell>
                <TableCell>{pct(r.passRate)}</TableCell>
                <TableCell>
                  {(r.status === "queued" || r.status === "running") && (
                    <Button
                      size="sm"
                      disabled={mutation.pending}
                      onClick={() =>
                        void run(
                          () => cancelRerun(detail.id, r.evalRunId),
                          "Re-run cancelled; it stays in the history.",
                        )
                      }
                    >
                      Cancel re-run
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {open && (
          <Button
            disabled={mutation.pending || running}
            onClick={() =>
              void run(
                () => rerunEvals(detail.id),
                "Re-run started in the Registry team. Refresh to follow it.",
              )
            }
          >
            Re-run evals
          </Button>
        )}
        {running && (
          <Button disabled={mutation.pending} onClick={onChanged}>
            Refresh
          </Button>
        )}
      </div>
    </div>
  );
}

const shown = (text: string) =>
  visibleParts(text)
    .map((p) => p.text)
    .join("");

function Finding({
  f,
  open,
  mutation,
  onAcknowledge,
}: {
  readonly f: ReviewFinding;
  readonly open: boolean;
  readonly mutation: Mutation;
  readonly onAcknowledge: (key: string) => void;
}) {
  return (
    <li>
      <code>
        {shown(f.file)}
        {f.line ? `:${f.line}` : ""}
      </code>{" "}
      {f.rule}{" "}
      {f.source === "external" ? (
        <>
          <Badge tone={f.severity === "caution" ? "attention" : "neutral"}>
            {f.externalSeverity ?? f.severity}
          </Badge>{" "}
          {f.title ? <span>{shown(f.title)} </span> : null}
        </>
      ) : (
        <>
          <Badge tone={f.severity === "block" ? "failed" : "attention"}>{f.severity}</Badge>{" "}
        </>
      )}
      {f.severity === "caution" &&
        (f.acknowledged ? (
          <span className="text-console-muted">acknowledged by {f.acknowledged.by.name}</span>
        ) : open ? (
          <Button
            size="sm"
            disabled={mutation.pending}
            onClick={() => onAcknowledge(f.key)}
            aria-label={`Acknowledge ${f.rule}${f.file ? ` in ${shown(f.file)}` : ""}${f.line ? ` line ${f.line}` : ""}`}
          >
            Acknowledge
          </Button>
        ) : null)}
    </li>
  );
}

const EXTERNAL_REASONS: Readonly<Record<string, string>> = {
  too_large: "the package is too large for it",
  no_image: "no scanner image is configured",
  registry_not_ready: "the Registry team is missing",
  interrupted: "the scan was interrupted",
  timeout: "the scan timed out",
  no_runner: "this server can't run scan Jobs",
  job_error: "its Job could not run",
  no_result: "it gave no result",
};

/**
 * The optional external scanner's part (KOBE-341, SK32): its state and its findings, apart from
 * Kobe's own. Advisory: MEDIUM and up are Caution findings to acknowledge, the rest information.
 */
function ExternalScan({
  state,
  findings,
  open,
  mutation,
  onAcknowledge,
}: {
  readonly state: ExternalScanState | undefined;
  readonly findings: readonly ReviewFinding[];
  readonly open: boolean;
  readonly mutation: Mutation;
  readonly onAcknowledge: (key: string) => void;
}) {
  if (!state) return null;
  if (state.status === "running" || state.status === "queued")
    return (
      <p>
        External scanner: {state.status === "queued" ? "waiting to scan" : "scanning"}. Approve
        waits for its findings.
      </p>
    );
  if (state.status !== "done")
    return (
      <>
        <p>
          External scanner: {state.status}
          {EXTERNAL_REASONS[state.reason] ? ` (${EXTERNAL_REASONS[state.reason]})` : ""}.
          Acknowledge that the package goes without it before approving; Kobe&apos;s own scan above
          still stands.
        </p>
        <ul className="list-disc ps-6">
          {findings.map((f) => (
            <Finding
              key={f.key}
              f={f}
              open={open}
              mutation={mutation}
              onAcknowledge={onAcknowledge}
            />
          ))}
        </ul>
      </>
    );
  return (
    <>
      <h4 className="mt-3 font-medium">
        External scanner (advisory): {state.scanner} {state.version}
      </h4>
      {findings.length === 0 ? (
        <p>No findings.</p>
      ) : (
        <ul className="list-disc ps-6">
          {findings.map((f) => (
            <Finding
              key={f.key}
              f={f}
              open={open}
              mutation={mutation}
              onAcknowledge={onAcknowledge}
            />
          ))}
        </ul>
      )}
      {state.truncated && <p className="text-console-muted">Only the first 200 are shown.</p>}
    </>
  );
}

export function ReviewEvidence({
  detail,
  mutation,
  onChanged,
}: {
  readonly detail: ReviewDetail;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const findings = detail.findings.filter((f) => f.source !== "external");
  const external = detail.findings.filter((f) => f.source === "external");
  const open = detail.state === "submitted" || detail.state === "in_review";
  const p = detail.provenance as { fromConversation?: boolean };
  const acknowledge = async (key: string) => {
    if (
      await mutation.run(
        () => acknowledgeFinding(detail.id, key),
        () => "Acknowledged.",
      )
    )
      onChanged();
  };
  return (
    <>
      <Section title="Scan" level={3}>
        <p>
          Verdict: <Badge tone={VERDICT_TONES[detail.verdict] ?? "neutral"}>{detail.verdict}</Badge>
          {detail.scan.rulesVersion && (
            <span className="ms-2 text-console-muted">rules {detail.scan.rulesVersion}</span>
          )}
        </p>
        {findings.length === 0 ? (
          <p>No findings.</p>
        ) : (
          <>
            <p>Acknowledge each Caution finding before approving.</p>
            <ul className="list-disc ps-6">
              {findings.map((f) => (
                <Finding
                  key={f.key}
                  f={f}
                  open={open}
                  mutation={mutation}
                  onAcknowledge={(k) => void acknowledge(k)}
                />
              ))}
            </ul>
          </>
        )}
        <ExternalScan
          state={detail.scan.external}
          findings={external}
          open={open}
          mutation={mutation}
          onAcknowledge={(k) => void acknowledge(k)}
        />
      </Section>
      <Section title="Scorecards" level={3}>
        <h4 className="font-medium">Authoritative (Registry team, Site judge)</h4>
        {detail.authoritativeScorecard ? (
          <Scorecard card={detail.authoritativeScorecard} />
        ) : (
          <Notice tone="warn" role="status">
            No authoritative scorecard yet: the version can&apos;t be approved until the evals are
            re-run in the Registry team.
          </Notice>
        )}
        <RerunControl detail={detail} open={open} mutation={mutation} onChanged={onChanged} />
        <h4 className="mt-3 font-medium">Submitted (the author&apos;s team)</h4>
        {detail.scorecard ? (
          <Scorecard card={detail.scorecard} />
        ) : (
          <EmptyState title="No scorecard came with it." />
        )}
      </Section>
      <Section title="Capabilities" level={3}>
        {detail.capabilities.egress.length === 0 ? (
          <p>Asks for no internet hosts.</p>
        ) : (
          <ul className="list-disc ps-6">
            {detail.capabilities.egress.map((e) => (
              <li key={e.host}>
                <code>{e.host}</code>{" "}
                {e.inCeiling ? (
                  <Badge tone="done">in the site egress ceiling</Badge>
                ) : (
                  <Badge tone="attention">not in the site egress ceiling</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Provenance" level={3}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="text-console-muted">Submitted by</dt>
          <dd className="m-0">{detail.submittedBy?.name ?? "—"}</dd>
          {detail.confirmedBy && (
            <>
              <dt className="text-console-muted">Confirmed by (Team admin)</dt>
              <dd className="m-0">{detail.confirmedBy.name}</dd>
            </>
          )}
          <dt className="text-console-muted">From team</dt>
          <dd className="m-0">
            {detail.source.teamName ?? "—"} ({detail.source.scope ?? "team"} skill)
          </dd>
          <dt className="text-console-muted">Started from a conversation</dt>
          <dd className="m-0">{p.fromConversation ? "Yes" : "No"}</dd>
          <dt className="text-console-muted">Maintainers</dt>
          <dd className="m-0">
            {detail.skill.maintainers.length === 0
              ? "None yet: the first approved submitter becomes one."
              : detail.skill.maintainers.map((m) => m.name).join(", ")}
          </dd>
        </dl>
      </Section>
      <Section title="Similar names" level={3}>
        {detail.similarNames.length === 0 ? (
          <p>No catalog name is close to {detail.skill.name}.</p>
        ) : (
          <Notice tone="warn" role="status">
            Close to {detail.similarNames.join(", ")}: check this isn&apos;t a lookalike.
          </Notice>
        )}
      </Section>
    </>
  );
}
