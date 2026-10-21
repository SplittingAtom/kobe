"use client";

/**
 * A notebook execution's outputs (KOBE-465), each shown as `lib/notebooks/outputs.ts` decides:
 * text and tracebacks as text, images as `<img>` from `data:` URLs, DataFrames as tables of text,
 * Markdown through the safe Markdown component, and other HTML only in the output frame.
 */
import { useMemo } from "react";
import type { NotebookOutput } from "@kobe/protocol";
import {
  browserHtmlParser,
  outputView,
  type HtmlParser,
  type OutputView,
} from "../../lib/notebooks/outputs";
import { Markdown } from "../chat/markdown";
import { OutputFrame } from "./output-frame";

const PRE = "overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs";

function TableOutput({ view }: { readonly view: Extract<OutputView, { kind: "table" }> }) {
  return (
    <div className="overflow-auto" data-kobe-output="table">
      <table className="border-collapse text-xs">
        {view.header.length > 0 && (
          <thead>
            {view.header.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <th key={c} scope="col" className="border px-2 py-0.5 text-start font-medium">
                    {cell}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
        )}
        <tbody>
          {view.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} className="border px-2 py-0.5 text-end tabular-nums">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {view.truncated && (
        <p className="text-muted-foreground text-xs">Showing the first {view.rows.length} rows.</p>
      )}
    </div>
  );
}

function OneView({ view, teamId }: { readonly view: OutputView; readonly teamId: string }) {
  switch (view.kind) {
    case "stream":
      return (
        <pre
          data-kobe-output={view.name}
          className={view.name === "stderr" ? `${PRE} text-destructive` : PRE}
        >
          {view.text}
        </pre>
      );
    case "error":
      return (
        <div role="group" aria-label="Error" data-kobe-output="error" className="text-destructive">
          <p className="font-mono text-xs font-semibold">{view.title}</p>
          {view.traceback !== "" && <pre className={PRE}>{view.traceback}</pre>}
        </div>
      );
    case "image":
      return <img src={view.src} alt={view.alt} data-kobe-output="image" className="max-w-full" />;
    case "table":
      return <TableOutput view={view} />;
    case "html":
      return <OutputFrame html={view.html} teamId={teamId} />;
    case "markdown":
      return <Markdown text={view.text} />;
    case "text":
      return (
        <pre data-kobe-output="text" className={PRE}>
          {view.text}
        </pre>
      );
    case "unsupported":
      return <p className="text-muted-foreground text-xs">This output cannot be shown here.</p>;
  }
}

/** Worked out once per output (a DataFrame's table is parsed once, not on every render). */
function OneOutput({
  output,
  parse,
  teamId,
}: {
  readonly output: NotebookOutput | null;
  readonly parse: HtmlParser | undefined;
  readonly teamId: string;
}) {
  const view = useMemo(() => outputView(output, parse), [output, parse]);
  return <OneView view={view} teamId={teamId} />;
}

export function NotebookOutputs({
  outputs,
  teamId,
}: {
  readonly outputs: readonly (NotebookOutput | null | undefined)[];
  readonly teamId: string;
}) {
  const parse = useMemo(() => browserHtmlParser(), []);
  const shown = outputs.filter((o) => o !== undefined);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-kobe-outputs="">
      {shown.map((output, i) => (
        <OneOutput key={i} output={output ?? null} parse={parse} teamId={teamId} />
      ))}
    </div>
  );
}
