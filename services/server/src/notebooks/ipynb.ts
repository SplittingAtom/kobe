import type { NotebookOutput } from "@kobe/protocol";

/**
 * Reading and writing nbformat 4 notebooks (docs/specs/notebooks.md NB1, NB11). The server never
 * runs a notebook; it reads a code cell's source and writes an execution's outputs back. Every
 * function returns new values: the parsed notebook is never changed in place.
 */
export type Notebook = Readonly<Record<string, unknown>> & {
  readonly nbformat: number;
  readonly cells: readonly Readonly<Record<string, unknown>>[];
};

export type NotebookProblem = "not_a_notebook" | "cell_not_found" | "not_code_cell";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** nbformat 4 JSON, or undefined (not JSON, another major version, no cell list). */
export function parseNotebook(text: string): Notebook | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.nbformat !== 4 || !Array.isArray(value.cells)) return undefined;
  if (!value.cells.every(isRecord)) return undefined;
  return value as Notebook;
}

/** A multi-line string (a string, or a list of lines) as one string. */
function joined(source: unknown): string | undefined {
  if (typeof source === "string") return source;
  if (Array.isArray(source) && source.every((s) => typeof s === "string")) return source.join("");
  return undefined;
}

/** The source of the code cell with id `cellId`. */
export function cellSource(
  notebook: Notebook,
  cellId: string,
):
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly problem: NotebookProblem } {
  const cell = notebook.cells.find((c) => c.id === cellId);
  if (cell === undefined) return { ok: false, problem: "cell_not_found" };
  if (cell.cell_type !== "code") return { ok: false, problem: "not_code_cell" };
  const source = joined(cell.source);
  return source === undefined ? { ok: false, problem: "not_a_notebook" } : { ok: true, source };
}

/** nbformat stores multi-line text as lists of lines; Kobe writes it that way too. */
function lines(text: string): string[] {
  const parts = text.split(/(?<=\n)/u);
  return parts.length === 1 && parts[0] === "" ? [] : parts;
}

const TEXT_MIME = new Set([
  "text/plain",
  "text/markdown",
  "text/latex",
  "text/html",
  "image/svg+xml",
]);

/** An output as nbformat writes it (text as lists of lines). */
export function storedOutput(output: NotebookOutput): Record<string, unknown> {
  if (output.output_type === "stream") return { ...output, text: lines(output.text) };
  if (output.output_type === "error") return { ...output };
  const data: Record<string, unknown> = {};
  for (const [mime, value] of Object.entries(output.data)) {
    data[mime] = TEXT_MIME.has(mime) && typeof value === "string" ? lines(value) : value;
  }
  return { ...output, data };
}

/** A copy of `notebook` whose cell `cellId` has these outputs and execution count. */
export function withOutputs(
  notebook: Notebook,
  cellId: string,
  outputs: readonly NotebookOutput[],
  executionCount: number | null,
): Notebook | undefined {
  const index = notebook.cells.findIndex((c) => c.id === cellId && c.cell_type === "code");
  if (index < 0) return undefined;
  const cells = notebook.cells.map((cell, i) =>
    i === index
      ? { ...cell, outputs: outputs.map(storedOutput), execution_count: executionCount }
      : cell,
  );
  return { ...notebook, cells };
}

/** Serialized as Jupyter does: one-space indent, a trailing newline. */
export function serializeNotebook(notebook: Notebook): string {
  return `${JSON.stringify(notebook, null, 1)}\n`;
}
