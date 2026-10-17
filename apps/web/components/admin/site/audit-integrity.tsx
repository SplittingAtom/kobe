"use client";

import { useState } from "react";
import {
  checkAuditIntegrity,
  type AuditChainProblem,
  type AuditIntegrity,
} from "../../../lib/admin/api/site/audit";
import { Button, Notice, Section } from "../../ui/console";
import { ErrorNotice } from "../error-notice";
import { DateTime } from "../parts";
import { useMutation } from "../use-resource";

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

/** The rate limit's message: the server allows 3 checks a minute per admin. */
export const RATE_LIMITED = "Try again in a minute: the chain can be verified 3 times a minute.";

interface Checked {
  readonly report: AuditIntegrity;
  /** When the check ran: the server's attestation time, else when the answer arrived. */
  readonly at: string;
}

/**
 * The hash chain's verification status (`GET /v1/site/audit/integrity`). The check reads the
 * whole log, so it runs only when an admin presses "Verify chain" (the server keeps no last
 * result: until then the page says "Not verified yet"). The latest result stays on screen, with
 * when it ran; a refusal by the 3-a-minute limit is a warning to wait, not an error.
 */
export function AuditIntegritySection() {
  const [checked, setChecked] = useState<Checked | null>(null);
  const check = useMutation();

  async function verify() {
    await check.run(checkAuditIntegrity, (report: AuditIntegrity) => {
      setChecked({ report, at: report.anchor?.at ?? new Date().toISOString() });
      return null;
    });
  }

  const limited = check.error?.status === 429;
  const failed = check.error !== null && !limited;
  return (
    <Section
      id="audit-integrity-heading"
      title="Chain integrity"
      description="Every event is chained to the one before it by its hash, so a changed, removed or inserted event breaks the chain. Verifying reads the whole log."
      actions={
        <Button size="sm" onClick={() => void verify()} loading={check.pending}>
          Verify chain
        </Button>
      }
    >
      {/* Mounted from the start, so each outcome is announced politely. */}
      <div role="status" className="sr-only">
        {announcement(check.pending, limited, failed, checked)}
      </div>
      {check.pending && (
        <p aria-hidden="true" className="m-0">
          Verifying the chain…
        </p>
      )}
      {limited && (
        <Notice tone="warn">
          <p>{RATE_LIMITED}</p>
        </Notice>
      )}
      {check.error && !limited && <ErrorNotice error={check.error} />}
      {checked ? (
        <>
          <p className="m-0 text-sm text-console-muted">
            {failed || limited ? "Previous result, checked " : "Last checked "}
            <DateTime value={checked.at} precise />
          </p>
          <IntegrityResult report={checked.report} />
        </>
      ) : (
        !check.pending && <p className="m-0">Not verified yet.</p>
      )}
    </Section>
  );
}

/** What the live region says; the check's time makes a repeated outcome a new message. */
function announcement(
  pending: boolean,
  limited: boolean,
  failed: boolean,
  checked: Checked | null,
): string {
  if (pending) return "Verifying the chain…";
  if (limited) return RATE_LIMITED;
  if (failed) return "The chain could not be verified.";
  if (!checked) return "";
  const at = new Date(checked.at).toLocaleTimeString();
  if (!checked.report.ok) {
    const seq = checked.report.problem?.seq;
    return `Chain verification failed at ${at}: the chain is broken${seq ? ` at event #${seq}` : ""}.`;
  }
  return `Chain verified at ${at}: ${count(checked.report.checked)}.`;
}

function IntegrityResult({ report }: { readonly report: AuditIntegrity }) {
  if (!report.ok) {
    const problem = report.problem;
    return (
      // A note, not an alert: the status region above already announces the outcome.
      <Notice tone="error" role="note" title="The chain is broken">
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
          <p>Record the head outside the cluster, as attested by the server:</p>
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
