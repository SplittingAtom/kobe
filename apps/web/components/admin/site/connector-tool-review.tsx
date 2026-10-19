"use client";

import {
  approveConnectorTools,
  listConnectorTools,
  type Connector,
  type ToolDefinition,
  type ToolReview,
} from "../../../lib/admin/api/site/connectors";
import { Button, Card, Section } from "../../ui/console";
import { ResourceView } from "../parts";
import { useResource, type Mutation } from "../use-resource";
import { TemplateReviewSection } from "./connector-template-review";

function Definition({ label, def }: { readonly label: string; readonly def: ToolDefinition }) {
  return (
    <section aria-label={label} className="min-w-0">
      <h4 className="m-0 text-sm font-semibold">{label}</h4>
      <p className="my-1">{def.description === "" ? "(no description)" : def.description}</p>
      <pre className="m-0 max-h-64 overflow-auto rounded-md border border-console-border bg-console-panel p-2 text-xs">
        {JSON.stringify(def.inputSchema, null, 2)}
      </pre>
    </section>
  );
}
/**
 * Re-approval of tools whose upstream definition changed or that are new (KOBE-102, D27): they
 * stay disabled for every team until a site admin approves them here, one by one or all.
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
    <Section
      title={`Tools of ${connector.name}`}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      <ResourceView state={state} label="tools">
        {(tools) => {
          const pending = tools.filter((t) => t.status === "drifted");
          return (
            <>
              <p className="m-0 mb-3 text-sm text-console-muted">
                Changed and new tools are disabled for every team until you approve them. Tools the
                server no longer lists are no longer offered.
              </p>
              {pending.length === 0 ? <p>No tools are waiting for approval.</p> : null}
              <div className="flex flex-col gap-3">
                {pending.map((t) => (
                  <Card key={t.name} role="article" aria-label={t.name}>
                    <h3 className="m-0 mb-2 text-base font-semibold">
                      <code>{t.name}</code> {t.change === "added" ? "(new)" : "(changed)"}
                    </h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      {t.approved ? <Definition label="Approved" def={t.approved} /> : null}
                      {t.live ? <Definition label="Now" def={t.live} /> : null}
                    </div>
                    <Button
                      size="sm"
                      variant="primary"
                      className="mt-3"
                      disabled={mutation.pending}
                      onClick={() => void approve([t])}
                    >
                      Approve<span className="sr-only"> {t.name}</span>
                    </Button>
                  </Card>
                ))}
              </div>
              {pending.length > 1 ? (
                <Button
                  variant="primary"
                  className="mt-3"
                  disabled={mutation.pending}
                  onClick={() => void approve(pending)}
                >
                  Approve all {pending.length}
                </Button>
              ) : null}
            </>
          );
        }}
      </ResourceView>
      <TemplateReviewSection connector={connector} mutation={mutation} onChanged={onChanged} />
    </Section>
  );
}
