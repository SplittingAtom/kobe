"use client";

import { useState } from "react";
import { ALL_CONNECTORS } from "@kobe/agent-file";
import {
  splitLines,
  type FieldErrors,
  type FormState,
} from "../../../../lib/admin/agent-builder/form-model";
import {
  allowTool,
  allowedTools,
  deniedTools,
  denyTool,
  withConnectorTools,
} from "../../../../lib/admin/agent-builder/tool-lists";
import type { TeamConnector } from "../../../../lib/admin/api/team/connectors";
import { Button, Checkbox, FieldError, Notice, TextInput } from "../../../ui/console";
import { useResource } from "../../use-resource";
import { useBuilderSources } from "./builder-sources";
import { fieldError } from "./field-errors";
import { PickList } from "./pick-list";

/** Pi tool names of the connectors' pinned tools (drifted ones are never offered, KOBE-102). */
function toolsOf(
  connectors: readonly TeamConnector[],
  names: readonly string[] | typeof ALL_CONNECTORS,
) {
  return connectors
    .filter((c) => names === ALL_CONNECTORS || names.includes(c.name))
    .flatMap((c) => c.tools.filter((t) => t.status === "pinned").map((t) => t.piName));
}

/**
 * The Behaviour tab's connectors and tool lists (KOBE-476 AC4): pick connectors from the team's
 * enabled ones (or every one), and their pinned tools appear under Allowed; each tool moves to
 * Denied and back with a button. Saved as `connectors`, `tools.deny` and, when the agent already
 * restricts its tools, `tools.allow` (lib/admin/agent-builder/tool-lists.ts).
 */
export function ConnectorTools({
  form,
  errors,
  readOnly,
  onChange,
}: {
  readonly form: FormState;
  readonly errors: FieldErrors;
  readonly readOnly: boolean;
  readonly onChange: (next: FormState) => void;
}) {
  const sources = useBuilderSources();
  const { state } = useResource(sources.connectors);
  const team =
    state.status === "ready" ? state.data.filter((c) => c.enabled && c.status === "active") : [];
  const chosen = splitLines(form.connectors);
  const replaced = form.connectorsAll ? chosen : [];

  // Each chosen connector's tools are written into tools.allow one by one (AC1, AC4); a
  // connector taken away takes its tools with it.
  const setConnectors = (next: readonly string[]) => {
    const added = next.filter((n) => !chosen.includes(n));
    const removed = chosen.filter((n) => !next.includes(n));
    onChange(
      withConnectorTools(
        { ...form, connectors: next.join("\n") },
        toolsOf(team, added),
        toolsOf(team, removed),
      ),
    );
  };
  const setAll = (all: boolean) => {
    const every = toolsOf(team, ALL_CONNECTORS);
    const current = toolsOf(team, chosen);
    const updated = { ...form, connectorsAll: all };
    onChange(
      all
        ? withConnectorTools(updated, every)
        : withConnectorTools(
            updated,
            [],
            every.filter((t) => !current.includes(t)),
          ),
    );
  };

  return (
    <>
      <PickList
        legend="Connectors"
        hint={
          state.status === "error"
            ? "The team's connectors couldn't be loaded; add a connector by name."
            : "Connectors the team enables. Each person still connects their own account."
        }
        chosen={chosen}
        options={team.map((c) => ({ value: c.name, label: c.name }))}
        noun="connector"
        readOnly={readOnly || form.connectorsAll}
        error={fieldError(errors.connectors)}
        allowTyped={state.status === "error"}
        onChange={setConnectors}
      />
      <Checkbox
        checked={form.connectorsAll}
        disabled={readOnly}
        onChange={(e) => setAll(e.target.checked)}
        label="Use every connector the team enables (each person still connects their own account)"
      />
      {replaced.length > 0 && (
        <Notice role="note" className="my-0">
          Every team connector replaces the connectors chosen above ({replaced.join(", ")}); they
          are not saved.
        </Notice>
      )}
      <ToolBoxes form={form} errors={errors} readOnly={readOnly} onChange={onChange} />
    </>
  );
}

function ToolBoxes({
  form,
  errors,
  readOnly,
  onChange,
}: {
  readonly form: FormState;
  readonly errors: FieldErrors;
  readonly readOnly: boolean;
  readonly onChange: (next: FormState) => void;
}) {
  const allowed = allowedTools(form);
  const denied = deniedTools(form);
  const restricted = splitLines(form.toolsAllow).length > 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
      <ToolBox
        title="Allowed tools"
        hint={
          restricted
            ? "Only the tools listed here are allowed. In Dangerous mode, those named one by one run without asking."
            : "Choosing a connector lists its tools here. While this list is empty, nothing is narrowed."
        }
        tools={allowed}
        action="Deny"
        addLabel="Add an allowed tool or glob"
        error={fieldError(errors.toolsAllow)}
        readOnly={readOnly}
        onMove={(tool) => onChange(denyTool(form, tool))}
        onAdd={(tool) => onChange(allowTool(form, tool))}
      />
      <ToolBox
        title="Denied tools"
        hint="Tools (or globs) this agent must never use, in any approval mode."
        tools={denied}
        action="Allow"
        addLabel="Add a denied tool or glob"
        error={fieldError(errors.toolsDeny)}
        readOnly={readOnly}
        onMove={(tool) => onChange(allowTool(form, tool))}
        onAdd={(tool) => onChange(denyTool(form, tool))}
      />
    </div>
  );
}

function ToolBox({
  title,
  hint,
  tools,
  action,
  addLabel,
  error,
  readOnly,
  onMove,
  onAdd,
}: {
  readonly title: string;
  readonly hint: string;
  readonly tools: readonly string[];
  readonly action: "Allow" | "Deny";
  readonly addLabel: string;
  readonly error: string | undefined;
  readonly readOnly: boolean;
  readonly onMove: (tool: string) => void;
  readonly onAdd: (tool: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const errorId = `${title.replace(/\s/g, "-").toLowerCase()}-error`;
  const add = () => {
    if (typed.trim() !== "") onAdd(typed.trim());
    setTyped("");
  };
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2">
      <h3 className="m-0 text-base font-medium">{title}</h3>
      <p className="m-0 text-sm text-console-muted">{hint}</p>
      {tools.length === 0 ? (
        <p className="m-0 text-sm text-console-muted">None.</p>
      ) : (
        <ul
          aria-label={title}
          className="m-0 flex max-h-64 list-none flex-col gap-1 overflow-y-auto rounded border border-solid border-console-border p-1"
        >
          {tools.map((tool) => (
            <li key={tool} className="flex items-center justify-between gap-2 px-1 text-sm">
              <code className="min-w-0 break-all">{tool}</code>
              {!readOnly && (
                <Button size="sm" aria-label={`${action} ${tool}`} onClick={() => onMove(tool)}>
                  {action === "Deny" ? "Deny →" : "← Allow"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            type="text"
            aria-label={addLabel}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button onClick={add}>Add</Button>
        </div>
      )}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </section>
  );
}
