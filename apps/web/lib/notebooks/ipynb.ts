/**
 * Notebooks in the web (KOBE-465, docs/specs/notebooks.md NB1, NB11): nbformat 4 JSON read,
 * edited and written back through the file editor's save path. Pure, and every function returns
 * a new notebook: the parsed one is never changed in place. Saved outputs are read into the
 * protocol's output shape (and checked against it) before anything renders them.
 */
import {
  NOTEBOOK_MIME_TYPES,
  notebookCellIdSchema,
  notebookOutputSchema,
  type NotebookOutput,
} from "@kobe/protocol";
import "../security/zod-jitless";

export type Cell = Readonly<Record<string, unknown>>;
export type Notebook = Readonly<Record<string, unknown>> & {
  readonly nbformat: number;
  readonly cells: readonly Cell[];
};
export type CellType = "code" | "markdown";

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

/** A multi-line string (a string, or a list of lines) as one string; anything else is empty. */
export function cellText(source: unknown): string {
  if (typeof source === "string") return source;
  if (Array.isArray(source) && source.every((s) => typeof s === "string")) return source.join("");
  return "";
}

export function cellId(cell: Cell): string {
  return typeof cell.id === "string" ? cell.id : "";
}

export function cellType(cell: Cell): CellType | "raw" {
  return cell.cell_type === "code" || cell.cell_type === "markdown" ? cell.cell_type : "raw";
}

/**
 * Every cell with a valid, unique nbformat 4.5 id (NB1: a cell is run by id); `added` says
 * whether any was given one, which the next save writes (with `nbformat_minor` at least 5).
 */
export function withCellIds(
  notebook: Notebook,
  newId: () => string,
): { readonly notebook: Notebook; readonly added: boolean } {
  const seen = new Set<string>();
  let added = false;
  const cells = notebook.cells.map((cell) => {
    const id = cell.id;
    if (typeof id === "string" && notebookCellIdSchema.safeParse(id).success && !seen.has(id)) {
      seen.add(id);
      return cell;
    }
    let fresh = newId();
    while (seen.has(fresh)) fresh = newId();
    seen.add(fresh);
    added = true;
    return { ...cell, id: fresh };
  });
  if (!added) return { notebook, added };
  const minor = typeof notebook.nbformat_minor === "number" ? notebook.nbformat_minor : 0;
  return { notebook: { ...notebook, cells, nbformat_minor: Math.max(minor, 5) }, added };
}

/** nbformat stores multi-line text as lists of lines; Kobe writes it that way too. */
function lines(text: string): string[] {
  const parts = text.split(/(?<=\n)/u);
  return parts.length === 1 && parts[0] === "" ? [] : parts;
}

function mapCells(notebook: Notebook, cells: readonly Cell[]): Notebook {
  return { ...notebook, cells };
}

export function setSource(notebook: Notebook, id: string, text: string): Notebook {
  return mapCells(
    notebook,
    notebook.cells.map((c) => (c.id === id ? { ...c, source: lines(text) } : c)),
  );
}

/** A new empty cell after `afterId` (null: at the top). */
export function addCell(
  notebook: Notebook,
  afterId: string | null,
  type: CellType,
  id: string,
): Notebook {
  const cell: Cell =
    type === "code"
      ? { cell_type: "code", id, metadata: {}, source: "", outputs: [], execution_count: null }
      : { cell_type: "markdown", id, metadata: {}, source: "" };
  const at = afterId === null ? 0 : notebook.cells.findIndex((c) => c.id === afterId) + 1;
  const index = at <= 0 && afterId !== null ? notebook.cells.length : at;
  return mapCells(notebook, [
    ...notebook.cells.slice(0, index),
    cell,
    ...notebook.cells.slice(index),
  ]);
}

/** The cell moved one place up (-1) or down (1); the same notebook when it cannot move. */
export function moveCell(notebook: Notebook, id: string, delta: -1 | 1): Notebook {
  const from = notebook.cells.findIndex((c) => c.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= notebook.cells.length) return notebook;
  const cells = [...notebook.cells];
  const [moved] = cells.splice(from, 1);
  if (moved === undefined) return notebook;
  cells.splice(to, 0, moved);
  return mapCells(notebook, cells);
}

export function deleteCell(notebook: Notebook, id: string): Notebook {
  return mapCells(
    notebook,
    notebook.cells.filter((c) => c.id !== id),
  );
}

/** Serialized as Jupyter does (and the server): one-space indent, a trailing newline. */
export function serializeNotebook(notebook: Notebook): string {
  return `${JSON.stringify(notebook, null, 1)}\n`;
}

const ALLOWED_MIME: ReadonlySet<string> = new Set(NOTEBOOK_MIME_TYPES);

/** One stored output in the protocol's shape, or null when it cannot be shown safely. */
function savedOutput(raw: unknown): NotebookOutput | null {
  if (!isRecord(raw)) return null;
  let candidate: Record<string, unknown> = raw;
  if (raw.output_type === "stream") candidate = { ...raw, text: cellText(raw.text) };
  else if (raw.output_type === "display_data" || raw.output_type === "execute_result") {
    const data: Record<string, unknown> = {};
    for (const [mime, value] of Object.entries(isRecord(raw.data) ? raw.data : {})) {
      if (!ALLOWED_MIME.has(mime)) continue;
      data[mime] = mime === "application/json" ? value : cellText(value);
    }
    candidate = { ...raw, data, metadata: isRecord(raw.metadata) ? raw.metadata : {} };
  }
  const parsed = notebookOutputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** A code cell's saved outputs; null marks one that cannot be shown. */
export function savedOutputs(cell: Cell): readonly (NotebookOutput | null)[] {
  return Array.isArray(cell.outputs) ? cell.outputs.map(savedOutput) : [];
}

export function executionCount(cell: Cell): number | null {
  return typeof cell.execution_count === "number" ? cell.execution_count : null;
}

/**
 * `local` (with the member's unsaved edits) taking the outputs and execution counts of the
 * server's newer version, cell by cell (same id): a run saved its outputs (NB11) while the member
 * kept typing, and neither is lost.
 */
export function withSavedResults(local: Notebook, server: Notebook): Notebook {
  const byId = new Map(server.cells.map((c) => [c.id, c]));
  return mapCells(
    local,
    local.cells.map((cell) => {
      const saved = typeof cell.id === "string" ? byId.get(cell.id) : undefined;
      if (saved === undefined || cell.cell_type !== "code" || saved.cell_type !== "code") {
        return cell;
      }
      return { ...cell, outputs: saved.outputs, execution_count: saved.execution_count };
    }),
  );
}
