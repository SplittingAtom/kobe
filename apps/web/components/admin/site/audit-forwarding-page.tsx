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
import styles from "../admin.module.css";

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

/**
 * Audit forwarding health (KOBE-182): per SIEM destination, whether events are delivered, how far
 * behind it is and the last error, from `GET /v1/site/audit/forwarding` (KOBE-19). Destinations are
 * set in the Helm values, not here.
 */
export function AuditForwardingPage() {
  const { state, reload } = useResource(getAuditForwarding);
  return (
    <>
      <h1>Audit forwarding</h1>
      <p className={styles.hint}>
        Kobe sends every audit event to your SIEM over syslog or OTLP. A destination that fails is
        retried with a growing wait (up to 15 minutes) and never skips an event.
      </p>
      <ResourceView state={state} label="forwarding status">
        {(health) => <ForwardingDetails health={health} />}
      </ResourceView>
      <p>
        <button type="button" onClick={reload} disabled={state.status === "loading"}>
          Refresh
        </button>
      </p>
    </>
  );
}

function ForwardingDetails({ health }: { readonly health: ForwardingHealth }) {
  if (!health.enabled) {
    return (
      <p>
        Forwarding is off. To send audit events to a SIEM, set <code>auditForwarding</code> (syslog
        or OTLP) in the Helm values and upgrade. Until then, download history with the audit export.
      </p>
    );
  }
  return (
    <>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>Forwarding destinations</caption>
          <thead>
            <tr>
              <th scope="col">Destination</th>
              <th scope="col">Status</th>
              <th scope="col">Events behind</th>
              <th scope="col">Delivered</th>
              <th scope="col">Last delivery</th>
              <th scope="col">Next attempt</th>
            </tr>
          </thead>
          <tbody>
            {health.destinations.map((d) => (
              <tr key={d.destination}>
                <th scope="row">{DESTINATION_LABEL[d.destination]}</th>
                <td>{statusLabel(d)}</td>
                <td>{d.behind ?? "—"}</td>
                <td>{d.delivered ?? "—"}</td>
                <td>
                  <DateTime value={d.lastSuccessAt} />
                </td>
                <td>{d.status === "ok" ? "—" : <DateTime value={d.nextAttemptAt} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
      <h2>{name}</h2>
      <p>
        <code>{message}</code>
      </p>
      <p className={styles.hint}>
        At <DateTime value={d.lastErrorAt} />.
        {d.status === "ok" ? " Resolved: delivery has worked since." : behind}
      </p>
    </>
  );
  if (d.status === "failing") {
    return (
      <section role="alert" aria-label={name} className={styles.error}>
        {body}
      </section>
    );
  }
  if (d.status === "retrying") {
    return (
      <section role="status" aria-label={name} className={styles.banner}>
        {body}
      </section>
    );
  }
  return (
    <section role="note" aria-label={name}>
      {body}
    </section>
  );
}
