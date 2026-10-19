"use client";

import type { ReviewDetail } from "../../../lib/admin/api/site/skill-review";
import { Badge, EmptyState, Notice, Section } from "../../ui/console";
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
export function ReviewEvidence({ detail }: { readonly detail: ReviewDetail }) {
  const findings = detail.scan.findings ?? [];
  const p = detail.provenance as { fromConversation?: boolean };
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
          <ul className="list-disc ps-6">
            {findings.map((f, i) => (
              <li key={i}>
                <code>
                  {f.file}
                  {f.line ? `:${f.line}` : ""}
                </code>{" "}
                {f.rule} {f.message ? `: ${f.message}` : ""}
              </li>
            ))}
          </ul>
        )}
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
