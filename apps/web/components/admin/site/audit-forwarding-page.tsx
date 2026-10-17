"use client";

import {
  getAuditForwarding,
  redactForwardingError,
  type DestinationHealth,
  type ForwardStatus,
  type ForwardingHealth,
} from "../../../lib/admin/api/site/audit-forwarding";
import { DateTime, ResourceView } from "../parts";
import { useResource } from "../use-resource";
import {
  Badge,
  Button,
  Notice,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  type BadgeTone,
} from "../../ui/console";

const DESTINATION_LABEL = { syslog: "Syslog", otlp: "OTLP" } as const;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function statusLabel(d: DestinationHealth): string {
  const failures = d.failures ?? 0;
  const labels: Record<ForwardStatus, string> = {
    ok: "Delivering",
    retrying: `Retrying (${count(failures, "failure", "failures")})`,
    failing: `Failing (${count(failures, "failure", "failures")} in a row)`,
    pending: "Waiting for the first run",
  };
  return labels[d.status];
}

const STATUS_TONE: Readonly<Record<ForwardStatus, BadgeTone>> = {
  ok: "running",
  retrying: "attention",
  failing: "failed",
  pending: "neutral",
};

/**
 * Audit forwarding health (KOBE-182): per SIEM destination, whether events are delivered, how far
 * behind it is and the last error, from `GET /v1/site/audit/forwarding` (KOBE-19). Destinations are
 * set in the Helm values, not here.
 */
export function AuditForwardingPage() {
  const { state, reload } = useResource(getAuditForwarding);
  return (
    <>
      <PageHeader
        title="Audit forwarding"
        description="Kobe sends every audit event to your SIEM over syslog or OTLP. A destination that fails is retried with a growing wait (up to 15 minutes) and never skips an event."
        actions={
          <Button onClick={reload} disabled={state.status === "loading"}>
            Refresh
          </Button>
        }
      />
      <ResourceView state={state} label="forwarding status">
        {(health) => <ForwardingDetails health={health} />}
      </ResourceView>
    </>
  );
}

function ForwardingDetails({ health }: { readonly health: ForwardingHealth }) {
  if (!health.enabled) {
    return (
      <Notice>
        <p>
          Forwarding is off. To send audit events to a SIEM, set <code>auditForwarding</code>{" "}
          (syslog or OTLP) in the Helm values and upgrade. Until then, download history with the
          audit export.
        </p>
      </Notice>
    );
  }
  return (
    <>
      <Table caption="Forwarding destinations">
        <TableHead>
          <TableRow>
            <TableHeader>Destination</TableHeader>
            <TableHeader>Status</TableHeader>
            <TableHeader numeric>Events behind</TableHeader>
            <TableHeader numeric>Delivered</TableHeader>
            <TableHeader>Last delivery</TableHeader>
            <TableHeader>Next attempt</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {health.destinations.map((d) => (
            <TableRow key={d.destination}>
              <TableRowHeader>{DESTINATION_LABEL[d.destination]}</TableRowHeader>
              <TableCell>
                <Badge tone={STATUS_TONE[d.status]}>{statusLabel(d)}</Badge>
              </TableCell>
              <TableCell numeric>{d.behind ?? "—"}</TableCell>
              <TableCell numeric>{d.delivered ?? "—"}</TableCell>
              <TableCell>
                <DateTime value={d.lastSuccessAt} />
              </TableCell>
              <TableCell>
                {d.status === "ok" ? "—" : <DateTime value={d.nextAttemptAt} />}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {health.destinations.map((d) => (
        <LastError key={d.destination} destination={d} />
      ))}
    </>
  );
}

/** Failing: an alert. Retrying: a warning. Recovered: the old error, marked resolved. */
function LastError({ destination: d }: { readonly destination: DestinationHealth }) {
  if (!d.lastError) return null;
  const name = `${DESTINATION_LABEL[d.destination]}: last error`;
  const message = redactForwardingError(d.lastError);
  const behind = d.behind ? ` ${count(d.behind, "event waits", "events wait")} for delivery.` : "";
  const body = (
    <>
      <h2 className="m-0 text-lg font-semibold">{name}</h2>
      <p>
        <code className="break-all">{message}</code>
      </p>
      <p className="text-sm text-console-muted">
        At <DateTime value={d.lastErrorAt} />.
        {d.status === "ok" ? " Resolved: delivery has worked since." : behind}
      </p>
    </>
  );
  if (d.status === "failing") {
    return (
      <Notice tone="error" role="alert" aria-label={name} className="mt-4">
        {body}
      </Notice>
    );
  }
  if (d.status === "retrying") {
    return (
      <Notice tone="warn" role="status" aria-label={name} className="mt-4">
        {body}
      </Notice>
    );
  }
  return (
    <section role="note" aria-label={name} className="mt-4">
      {body}
    </section>
  );
}
