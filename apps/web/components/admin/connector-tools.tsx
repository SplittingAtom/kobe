"use client";

import type { ReactNode } from "react";

/**
 * Connector tools in two labelled columns, Read only and Write (KOBE-639), shared by the team
 * Connectors panel and the site connector detail panel (KOBE-641). A tool is read-only only when
 * its pinned annotations say `readOnlyHint: true`; anything else, a tool without annotations
 * included, is Write: the same rule as exposure `read_only` on the server (mcp/catalog.ts).
 */
export interface ToolGroups<T> {
  readonly readOnly: readonly T[];
  readonly write: readonly T[];
}

export function groupTools<T>(
  tools: readonly T[],
  isReadOnly: (tool: T) => boolean,
): ToolGroups<T> {
  return {
    readOnly: tools.filter((t) => isReadOnly(t)),
    write: tools.filter((t) => !isReadOnly(t)),
  };
}

const COLUMNS = [
  { key: "readOnly", title: "Read only", empty: "No read-only tools." },
  { key: "write", title: "Write", empty: "No write tools." },
] as const;

/**
 * The two columns side by side; under the `md` breakpoint they stack, one group after the other.
 * Each column is a region named "<group> tools of <connector>" with its count in the heading.
 */
export function ToolColumns<T>({
  connectorName,
  tools,
  isReadOnly,
  toolName,
  renderTool,
}: {
  readonly connectorName: string;
  readonly tools: readonly T[];
  readonly isReadOnly: (tool: T) => boolean;
  /** The upstream tool name: unique within a pinned snapshot, so also the list key. */
  readonly toolName: (tool: T) => string;
  readonly renderTool: (tool: T) => ReactNode;
}) {
  const groups = groupTools(tools, isReadOnly);
  return (
    <div className="my-2 grid gap-3 md:grid-cols-2">
      {COLUMNS.map((col) => {
        const list = groups[col.key];
        return (
          <section
            key={col.key}
            aria-label={`${col.title} tools of ${connectorName}`}
            className="min-w-0 rounded-md border border-console-border p-2"
          >
            <h3 className="m-0 mb-1 flex items-center gap-2 text-sm font-semibold">
              {col.title}
              <span className="text-console-muted">({list.length})</span>
            </h3>
            {list.length === 0 ? (
              <p className="m-0 text-sm text-console-muted">{col.empty}</p>
            ) : (
              <ul aria-label={`${col.title} tools`} className="m-0 grid list-none gap-1 p-0">
                {list.map((t) => (
                  <li
                    key={toolName(t)}
                    aria-label={`${toolName(t)} tool`}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1"
                  >
                    {renderTool(t)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
