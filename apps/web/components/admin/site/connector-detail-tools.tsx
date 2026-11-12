"use client";

import type {
  TemplateReview,
  ToolDefinition,
  ToolReview,
} from "../../../lib/admin/api/site/connectors";
import type { ToolApp } from "../../../lib/admin/api/team/connectors";
import { Badge } from "../../ui/console";
import { McpUiBadge, ToolColumns } from "../connector-tools";

/**
 * Every tool of a connector in the site detail panel (KOBE-641): Read only and Write columns, each
 * tool with its description, risk annotations, an input summary, its MCP-UI badge (KOBE-640) and
 * whether it is pinned or awaiting approval. Definitions only: the review stays in Review.
 */
const MAX_INPUTS = 12;

/** The definition in force: the approved one, or for a new tool the live one awaiting approval. */
const definitionOf = (t: ToolReview): ToolDefinition | undefined => t.approved ?? t.live;

const hint = (d: ToolDefinition | undefined, key: string): boolean | undefined => {
  const v = d?.annotations?.[key];
  return typeof v === "boolean" ? v : undefined;
};

/** Read only only when the tool declares `readOnlyHint: true` (as exposure read_only). */
export const toolIsReadOnly = (t: ToolReview) => hint(definitionOf(t), "readOnlyHint") === true;

interface Input {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

function inputsOf(schema: Record<string, unknown> | undefined): Input[] {
  const props = schema?.properties;
  if (props === null || typeof props !== "object" || Array.isArray(props)) return [];
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((x): x is string => typeof x === "string")
      : [],
  );
  return Object.entries(props as Record<string, unknown>).map(([name, p]) => {
    const type = (p as { readonly type?: unknown } | null)?.type;
    return {
      name,
      type: typeof type === "string" ? type : Array.isArray(type) ? type.join(" | ") : "any",
      required: required.has(name),
    };
  });
}

function Inputs({ schema }: { readonly schema: Record<string, unknown> | undefined }) {
  const inputs = inputsOf(schema);
  if (inputs.length === 0) return <p className="m-0 text-xs text-console-muted">No inputs</p>;
  const shown = inputs.slice(0, MAX_INPUTS);
  return (
    <p className="m-0 text-xs text-console-muted">
      Inputs:{" "}
      {shown.map((i, n) => (
        <span key={i.name}>
          {n > 0 ? ", " : null}
          <code>{`${i.name} (${i.type}${i.required ? ", required" : ""})`}</code>
        </span>
      ))}
      {inputs.length > shown.length ? `, and ${inputs.length - shown.length} more` : null}
    </p>
  );
}

/** Risk annotations in words; an undeclared hint shows MCP's default, marked as assumed. */
function Annotations({ def }: { readonly def: ToolDefinition | undefined }) {
  const readOnly = hint(def, "readOnlyHint") === true;
  const destructive = hint(def, "destructiveHint");
  const openWorld = hint(def, "openWorldHint");
  const assumed = "Not declared by the tool: MCP's default";
  return (
    <span className="inline-flex flex-wrap gap-1">
      {readOnly ? null : destructive === false ? (
        <Badge>Not destructive</Badge>
      ) : (
        <Badge tone="attention" {...(destructive === undefined ? { title: assumed } : {})}>
          Destructive
        </Badge>
      )}
      {hint(def, "idempotentHint") === true ? <Badge>Idempotent</Badge> : null}
      <Badge {...(openWorld === undefined ? { title: assumed } : {})}>
        {openWorld === false ? "Closed world" : "Open world"}
      </Badge>
    </span>
  );
}

/** The tool's template with its review, from the templates list (null while it is not loaded). */
function appOf(
  def: ToolDefinition | undefined,
  templates: readonly TemplateReview[] | null,
): ToolApp | null {
  const uri = def?.ui?.resourceUri;
  if (uri === undefined) return null;
  if (templates === null) return { resourceUri: uri, review: "unknown" };
  const t = templates.find((x) => x.uri === uri);
  return {
    resourceUri: uri,
    review: t === undefined ? "missing" : t.status === "pinned" ? "approved" : "pending",
  };
}

function ToolItem({
  tool: t,
  templates,
}: {
  readonly tool: ToolReview;
  readonly templates: readonly TemplateReview[] | null;
}) {
  const def = definitionOf(t);
  return (
    <div className="grid w-full gap-1 border-b border-console-border py-1.5 last:border-b-0">
      <span className="flex flex-wrap items-center gap-1.5">
        <code className="font-semibold">{t.name}</code>
        <McpUiBadge app={appOf(def, templates)} />
        {t.status === "pinned" ? (
          <Badge tone="done">Pinned</Badge>
        ) : (
          <Badge tone="attention">
            Awaiting approval ({t.change === "added" ? "new" : "changed"})
          </Badge>
        )}
      </span>
      {def?.title ? <span className="text-sm">{def.title}</span> : null}
      {def?.description ? (
        <p className="m-0 text-sm break-words whitespace-pre-line">{def.description}</p>
      ) : null}
      <Annotations def={def} />
      <Inputs schema={def?.inputSchema} />
    </div>
  );
}

export function ConnectorDetailTools({
  connectorName,
  tools,
  templates,
}: {
  readonly connectorName: string;
  readonly tools: readonly ToolReview[];
  readonly templates: readonly TemplateReview[] | null;
}) {
  if (tools.length === 0) return <p className="m-0 text-sm">No tools are pinned yet.</p>;
  return (
    <ToolColumns
      connectorName={connectorName}
      tools={tools}
      isReadOnly={toolIsReadOnly}
      toolName={(t) => t.name}
      renderTool={(t) => <ToolItem tool={t} templates={templates} />}
    />
  );
}
