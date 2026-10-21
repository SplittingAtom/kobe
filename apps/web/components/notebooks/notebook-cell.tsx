"use client";

/**
 * One notebook cell (KOBE-465): code in a compact CodeMirror view (Shift+Enter runs it) with its
 * execution count and outputs, Markdown rendered by the safe Markdown component until edited.
 * Move, delete and add buttons act on the notebook (`notebook-view.tsx`).
 */
import { lazy, Suspense, useState } from "react";
import type { NotebookOutput } from "@kobe/protocol";
import { cellText, cellType, type Cell, type CellType } from "../../lib/notebooks/ipynb";
import type { Execution } from "../../lib/notebooks/executions";
import { Markdown } from "../chat/markdown";
import { BUTTON, EditorFallback } from "../files/file-editor";
import { ExecutionNote } from "./execution-status";
import { NotebookOutputs } from "./output-view";

const CodeEditor = lazy(() => import("../files/code-editor"));

export interface CellProps {
  readonly cell: Cell;
  /** 1-based, for names ("Cell 2"). */
  readonly number: number;
  readonly first: boolean;
  readonly last: boolean;
  readonly editable: boolean;
  readonly canRun: boolean;
  /** `[n]`, `[*]` while running, `[ ]` never run. */
  readonly count: string;
  readonly outputs: readonly (NotebookOutput | null | undefined)[];
  /** The execution shown live (this tab's or the agent's), if any. */
  readonly live: Execution | undefined;
  readonly teamId: string;
  onSource(text: string): void;
  onRun(): void;
  onMove(delta: -1 | 1): void;
  onDelete(): void;
  onAdd(type: CellType): void;
}

function CellActions(props: CellProps & { readonly label: string }) {
  const { number, first, last, editable, label } = props;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        className={BUTTON}
        disabled={!editable || first}
        aria-label={`Move cell ${number} up`}
        onClick={() => props.onMove(-1)}
      >
        Up
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={!editable || last}
        aria-label={`Move cell ${number} down`}
        onClick={() => props.onMove(1)}
      >
        Down
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={!editable}
        aria-label={`Delete cell ${number}`}
        onClick={props.onDelete}
      >
        Delete
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={!editable}
        aria-label={`Add a code cell below cell ${number}`}
        onClick={() => props.onAdd("code")}
      >
        + Code
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={!editable}
        aria-label={`Add a Markdown cell below cell ${number}`}
        onClick={() => props.onAdd("markdown")}
      >
        + Markdown
      </button>
      <span className="text-muted-foreground ms-auto text-xs">{label}</span>
    </div>
  );
}

function CodeCell(props: CellProps) {
  const { cell, number, editable, canRun, count, live } = props;
  return (
    <>
      <div className="flex items-start gap-2">
        <div className="flex w-12 shrink-0 flex-col items-end gap-1 pt-1">
          <span className="text-muted-foreground font-mono text-xs" data-kobe-exec-count="">
            {count}
          </span>
          <button
            type="button"
            className={BUTTON}
            disabled={!canRun}
            aria-label={`Run cell ${number}`}
            onClick={props.onRun}
          >
            Run
          </button>
        </div>
        <div className="min-w-0 flex-1">
          <Suspense fallback={<EditorFallback />}>
            <CodeEditor
              value={cellText(cell.source)}
              language="python"
              label={`Code of cell ${number}`}
              readOnly={!editable}
              compact
              onChange={props.onSource}
              onRun={canRun ? props.onRun : undefined}
            />
          </Suspense>
        </div>
      </div>
      <div
        className="ms-14 flex flex-col gap-1"
        aria-label={`Output of cell ${number}`}
        role="group"
      >
        {live && <ExecutionNote exec={live} notebook />}
        <NotebookOutputs outputs={props.outputs} teamId={props.teamId} />
      </div>
    </>
  );
}

function MarkdownCell(props: CellProps) {
  const { cell, number, editable } = props;
  const [editing, setEditing] = useState(false);
  const text = cellText(cell.source);
  return (
    <div className="ms-14 flex flex-col gap-1">
      {editing && editable ? (
        <Suspense fallback={<EditorFallback />}>
          <CodeEditor
            value={text}
            language="markdown"
            label={`Markdown of cell ${number}`}
            compact
            onChange={props.onSource}
            onRun={() => setEditing(false)}
          />
        </Suspense>
      ) : text.trim() === "" ? (
        <p className="text-muted-foreground text-xs">Empty Markdown cell.</p>
      ) : (
        <Markdown text={text} />
      )}
      {editable && (
        <button
          type="button"
          className={`${BUTTON} self-start`}
          aria-label={editing ? `Done editing cell ${number}` : `Edit cell ${number}`}
          onClick={() => setEditing(!editing)}
        >
          {editing ? "Done" : "Edit"}
        </button>
      )}
    </div>
  );
}

export function NotebookCell(props: CellProps) {
  const type = cellType(props.cell);
  const label = type === "code" ? "Code" : type === "markdown" ? "Markdown" : "Raw";
  return (
    <section
      aria-label={`Cell ${props.number} (${label})`}
      data-kobe-cell={typeof props.cell.id === "string" ? props.cell.id : ""}
      className="flex flex-col gap-1 rounded-md border p-2"
    >
      <CellActions {...props} label={label} />
      {type === "code" ? (
        <CodeCell {...props} />
      ) : type === "markdown" ? (
        <MarkdownCell {...props} />
      ) : (
        <pre className="ms-14 font-mono text-xs whitespace-pre-wrap">
          {cellText(props.cell.source)}
        </pre>
      )}
    </section>
  );
}
