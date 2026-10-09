"use client";

import {
  approveConnectorTools,
  listConnectorTools,
  type Connector,
  type ToolDefinition,
  type ToolReview,
} from "../../../lib/admin/api/install/connectors";
import { ResourceView } from "../parts";
import { useResource, type Mutation } from "../use-resource";
import styles from "../admin.module.css";

function Definition({ label, def }: { readonly label: string; readonly def: ToolDefinition }) {
  return (
    <section aria-label={label}>
      <h4>{label}</h4>
      <p>{def.description === "" ? "(no description)" : def.description}</p>
      <pre>{JSON.stringify(def.inputSchema, null, 2)}</pre>
    </section>
  );
}

/**
 * Re-approval of tools whose upstream definition changed or that are new (KOBE-102, D27): they
 * stay disabled for every team until an install admin approves them here, one by one or all.
 */
export function ToolReviewPanel({
  connector,
  mutation,
  onChanged,
  onClose,
}: {
  readonly connector: Connector;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
  readonly onClose: () => void;
}) {
  const { state, reload } = useResource(() => listConnectorTools(connector.id));

  async function approve(tools: readonly ToolReview[]) {
    const reviewed = tools.flatMap((t) =>
      t.live ? [{ name: t.name, sha256: t.live.sha256 }] : [],
    );
    const done = await mutation.run(
      () => approveConnectorTools(connector.id, reviewed),
      (r) => `Approved ${r.approved.length} tool${r.approved.length === 1 ? "" : "s"}.`,
    );
    reload();
    if (done) onChanged();
  }

  return (
    <section aria-label={`Tools of ${connector.name}`}>
      <h2>Tools of {connector.name}</h2>
      <ResourceView state={state} label="tools">
        {(tools) => {
          const pending = tools.filter((t) => t.status === "drifted");
          return (
            <>
              <p className={styles.hint}>
                Changed and new tools are disabled for every team until you approve them. Tools the
                server no longer lists are no longer offered.
              </p>
              {pending.length === 0 ? <p>No tools are waiting for approval.</p> : null}
              {pending.map((t) => (
                <article key={t.name} aria-label={t.name}>
                  <h3>
                    <code>{t.name}</code> {t.change === "added" ? "(new)" : "(changed)"}
                  </h3>
                  {t.approved ? <Definition label="Approved" def={t.approved} /> : null}
                  {t.live ? <Definition label="Now" def={t.live} /> : null}
                  <button
                    type="button"
                    disabled={mutation.pending}
                    onClick={() => void approve([t])}
                  >
                    Approve<span className={styles.visuallyHidden}> {t.name}</span>
                  </button>
                </article>
              ))}
              {pending.length > 1 ? (
                <button
                  type="button"
                  disabled={mutation.pending}
                  onClick={() => void approve(pending)}
                >
                  Approve all {pending.length}
                </button>
              ) : null}
            </>
          );
        }}
      </ResourceView>{" "}
      <button type="button" onClick={onClose}>
        Close
      </button>
    </section>
  );
}
