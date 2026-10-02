"use client";

import { useState } from "react";
import {
  getIsolation,
  recheckIsolation,
  type IsolationStatus,
} from "../../../lib/admin/api/install/isolation";
import { MutationStatus } from "../error-notice";
import { ISOLATION_EVENT } from "../isolation-banner";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

const STATE_LABEL = {
  verified: "Verified",
  missing: "Missing",
  checking: "Checking",
} as const;

/**
 * Isolation status (spec D4, KOBE-9 `/v1/install/isolation`). Without a gVisor or Kata runtime Kobe
 * refuses to run agents and "the admin console shows the fix": this page.
 */
export function IsolationPage() {
  const { state } = useResource(getIsolation);
  const mutation = useMutation();
  const [fresh, setFresh] = useState<IsolationStatus | null>(null);

  async function recheck() {
    await mutation.run(recheckIsolation, (status) => {
      setFresh(status);
      window.dispatchEvent(new CustomEvent(ISOLATION_EVENT, { detail: status.state }));
      return status.state === "verified"
        ? "Isolation verified: agents are enabled."
        : "Checked again.";
    });
  }

  return (
    <>
      <h1>Isolation</h1>
      <p className={styles.hint}>
        Kobe runs agents only in a gVisor or Kata sandbox. There is no way to turn this off.
      </p>
      <ResourceView state={state} label="isolation status">
        {(initial) => <IsolationDetails status={fresh ?? initial} />}
      </ResourceView>
      <p>
        <button type="button" onClick={() => void recheck()} disabled={mutation.pending}>
          {mutation.pending ? "Checking…" : "Re-check now"}
        </button>
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </>
  );
}

function IsolationDetails({ status }: { readonly status: IsolationStatus }) {
  return (
    <>
      <dl className={styles.dl} aria-label="Isolation status">
        <dt>Runtime check</dt>
        <dd>{STATE_LABEL[status.state]}</dd>
        <dt>Agents</dt>
        <dd>{status.agentsEnabled ? "Enabled" : "Disabled"}</dd>
        <dt>RuntimeClass</dt>
        <dd>
          {status.runtimeClassName ? <code>{status.runtimeClassName}</code> : "Not configured"}
        </dd>
        {status.state === "verified" && (
          <>
            <dt>Handler</dt>
            <dd>
              <code>{status.handler}</code>
            </dd>
          </>
        )}
        {status.state !== "checking" && (
          <>
            <dt>Last checked</dt>
            <dd>
              <DateTime value={status.checkedAt} />
            </dd>
          </>
        )}
      </dl>
      {status.state === "checking" && <p role="status">The first check is still running.</p>}
      {status.state === "missing" && <Fix status={status} />}
    </>
  );
}

function Fix({ status }: { readonly status: Extract<IsolationStatus, { state: "missing" }> }) {
  const runtimeClass = status.runtimeClassName ?? "gvisor";
  return (
    <section aria-labelledby="isolation-fix" className={styles.banner}>
      <h2 id="isolation-fix">Agents are disabled: isolation runtime missing</h2>
      <p>{status.message}</p>
      <ol>
        <li>
          Install gVisor on every node, one node at a time (as root):{" "}
          <code>sudo scripts/install-gvisor-k3s.sh</code>
        </li>
        <li>
          Create the RuntimeClass once per cluster:{" "}
          <code>kubectl apply -f charts/kobe/runtimeclass-gvisor.yaml</code>
        </li>
        <li>
          Install the agent-sandbox controller: <code>scripts/install-agent-sandbox.sh</code>
        </li>
        <li>
          Check that the chart value <code>isolation.runtimeClassName</code> names a RuntimeClass
          that exists (<code>{runtimeClass}</code>) and that its handler is <code>runsc</code>{" "}
          (gVisor) or <code>kata…</code> (Kata). The handler counts, not the name.
        </li>
        <li>Press “Re-check now”. Agents start working as soon as the check passes.</li>
      </ol>
      <p className={styles.hint}>
        Details: <code>{status.docs}</code> in the Kobe repository.
      </p>
    </section>
  );
}
