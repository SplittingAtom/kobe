"use client";

import {
  checkAuditIntegrity,
  type AuditChainProblem,
  type AuditIntegrity,
} from "../../../lib/admin/api/site/audit";
import { Button, Notice, Section } from "../../ui/console";
import { ErrorNotice } from "../error-notice";
import { DateTime } from "../parts";
import { useResource } from "../use-resource";

/** What each failed check means, for people (packages/db/src/audit/verify.ts). */
export const CHAIN_PROBLEM_LABEL: Readonly<Record<AuditChainProblem, string>> = {
  gap: "an event is missing or out of place",
  prev_hash_mismatch:
    "it does not link to the event before it (an event was removed, inserted or re-chained)",
  hash_mismatch: "its contents do not match its hash (the event was edited)",
  pii_mismatch: "its IP address or user agent does not match what was recorded",
  seal_mismatch: "the events chained before the upgrade do not match their seal",
  extra_seal: "a second chain-upgrade seal was recorded",
};

const count = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "event" : "events"}`;

/**
 * The hash chain's verification status (`GET /v1/site/audit/integrity`): checked once when the
 * page opens and again on request. The server allows 3 checks a minute (each reads the whole log),
 * so a refusal is a warning to wait, not an error.
 */
export function AuditIntegritySection() {
  const { state, reload } = useResource(checkAuditIntegrity);
  return (
    <Section
      id="audit-integrity-heading"
      title="Chain integrity"
      description="Every event is chained to the one before it by its hash, so a changed, removed or inserted event breaks the chain."
      actions={
        <Button size="sm" onClick={reload} loading={state.status === "loading"}>
          Check again
        </Button>
      }
    >
      <div role="status">
        {state.status === "loading" && <p className="m-0">Checking the chain…</p>}
        {state.status === "ready" && <IntegrityResult report={state.data} />}
      </div>
      {state.status === "error" &&
        (state.error.status === 429 ? (
          <Notice tone="warn" role="status">
            <p>{state.error.message}</p>
          </Notice>
        ) : (
          <ErrorNotice error={state.error} />
        ))}
    </Section>
  );
}

function IntegrityResult({ report }: { readonly report: AuditIntegrity }) {
  if (!report.ok) {
    const problem = report.problem;
    return (
      <Notice tone="error" title="The chain is broken">
        <p>
          {problem
            ? `Event #${problem.seq}: ${CHAIN_PROBLEM_LABEL[problem.kind] ?? problem.kind}.`
            : "The check found a problem."}{" "}
          Treat this as an integrity incident: compare with the heads recorded outside the cluster
          (server log, SIEM).
        </p>
      </Notice>
    );
  }
  if (!report.head) {
    return (
      <Notice tone="success" title="Chain verified">
        <p>The log is empty.</p>
      </Notice>
    );
  }
  return (
    <Notice tone="success" title="Chain verified">
      <p>
        All {count(report.checked)} chain correctly, up to event #{report.head.seq}.
      </p>
      {report.anchor && (
        <>
          <p>
            Record the head outside the cluster, as attested by the server (
            <DateTime value={report.anchor.at} />
            ):
          </p>
          <p>
            <code className="break-all">
              {report.anchor.seq}:{report.anchor.hash}
            </code>
          </p>
          <p className="text-sm text-console-muted">
            Attestation: <code className="break-all">{report.anchor.mac}</code>
          </p>
        </>
      )}
    </Notice>
  );
}
