import {
  SEMANTIC_MEMORY_CSV_COLUMNS,
  SEMANTIC_MEMORY_CSV_TAG_SEPARATOR,
  SEMANTIC_MEMORY_EXPORT_FORMAT,
  SEMANTIC_MEMORY_IMPORT_MAX_ROWS,
  restoreCsvCell,
  semanticMemoryDateSchema,
  semanticMemoryKindSchema,
  semanticMemoryStatementSchema,
  semanticMemoryStatusSchema,
  semanticMemoryTagSchema,
  type SemanticMemoryKind,
  type SemanticMemoryStatus,
  type SemanticMemoryTransferFormat,
} from "@kobe/protocol";
import { MemoryItemError } from "../items/errors.js";

/**
 * Reading an import file (KOBE-385; contract KOBE-377 `transfer.ts`). A file that can't be read
 * as its format at all is `memory_import_invalid`; more rows than one scope holds is
 * `memory_import_too_large`. A row that doesn't fit is kept with its `error` so the preview can
 * show it as `invalid`; nothing here touches the database.
 *
 * JSON: an export document (`format: kobe.memory.v1`, `items`); `ref`, `tags`, `pinned`, `as_of`,
 * `policy`, `status` and `superseded_by` may be left out. CSV: a header row naming any of the
 * contract's columns (`statement` required), in any order, so `statement,kind,tags,pinned`
 * reads; tags are separated by `;` (or `,` inside a quoted cell).
 */
export interface ImportRow {
  readonly index: number;
  readonly ref: string | null;
  readonly kind: SemanticMemoryKind | null;
  readonly statement: string;
  readonly tags: string[];
  readonly pinned: boolean;
  readonly policy: boolean;
  readonly asOf: string | null;
  readonly status: SemanticMemoryStatus;
  readonly supersededBy: string | null;
  /** Why the row can't be imported as read; null when it parsed. */
  readonly error: string | null;
}

const tooLarge = () =>
  new MemoryItemError(
    "memory_import_too_large",
    `An import holds at most ${SEMANTIC_MEMORY_IMPORT_MAX_ROWS} rows.`,
  );
const unreadable = (message: string) => new MemoryItemError("memory_import_invalid", message);

/** Fields as read, before they are checked. */
interface RawRow {
  readonly ref?: unknown;
  readonly kind?: unknown;
  readonly statement?: unknown;
  readonly tags?: unknown;
  readonly pinned?: unknown;
  readonly as_of?: unknown;
  readonly policy?: unknown;
  readonly status?: unknown;
  readonly superseded_by?: unknown;
}

export function parseImport(format: SemanticMemoryTransferFormat, content: string): ImportRow[] {
  const raws = format === "json" ? readJson(content) : readCsv(content);
  if (raws.length > SEMANTIC_MEMORY_IMPORT_MAX_ROWS) throw tooLarge();
  return raws.map((raw, index) => toRow(raw, index));
}

function readJson(content: string): RawRow[] {
  let doc: unknown;
  try {
    doc = JSON.parse(content.startsWith("\uFEFF") ? content.slice(1) : content);
  } catch {
    throw unreadable("The file is not valid JSON.");
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    throw unreadable(`The file is not a Kobe memory export (${SEMANTIC_MEMORY_EXPORT_FORMAT}).`);
  const { format, items } = doc as { format?: unknown; items?: unknown };
  if (format !== SEMANTIC_MEMORY_EXPORT_FORMAT || !Array.isArray(items))
    throw unreadable(`The file is not a Kobe memory export (${SEMANTIC_MEMORY_EXPORT_FORMAT}).`);
  // Before any per-row work (review-385 I-1).
  if (items.length > SEMANTIC_MEMORY_IMPORT_MAX_ROWS) throw tooLarge();
  return items.map((i: unknown) =>
    i !== null && typeof i === "object" && !Array.isArray(i) ? (i as RawRow) : {},
  );
}

/** RFC 4180 records: quoted cells may hold commas, quotes ("") and line breaks. */
export function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const endRecord = () => {
    record.push(cell);
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
    cell = "";
  };
  while (i < body.length) {
    const ch = body[i] as string;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (ch === '"') quoted = false;
      else cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      record.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      endRecord();
      if (ch === "\r" && body[i + 1] === "\n") i += 1;
    } else cell += ch;
    i += 1;
  }
  if (quoted) throw unreadable("A quoted CSV cell is never closed.");
  if (cell !== "" || record.length > 0) endRecord();
  // Guard the row count before any further work on a huge file.
  if (records.length > SEMANTIC_MEMORY_IMPORT_MAX_ROWS + 1) throw tooLarge();
  return records;
}

const COLUMNS: ReadonlySet<string> = new Set(SEMANTIC_MEMORY_CSV_COLUMNS);

function readCsv(content: string): RawRow[] {
  const [header, ...rows] = csvRecords(content);
  if (!header) throw unreadable("The CSV file is empty.");
  const names = header.map((h) => h.trim().toLowerCase());
  const unknown = names.filter((n) => !COLUMNS.has(n));
  if (unknown.length > 0)
    throw unreadable(
      `Unknown CSV column ${unknown.map((n) => `"${n.slice(0, 40)}"`).join(", ")}. Columns: ${SEMANTIC_MEMORY_CSV_COLUMNS.join(", ")}.`,
    );
  if (!names.includes("statement")) throw unreadable("The CSV header needs a statement column.");
  if (new Set(names).size !== names.length) throw unreadable("A CSV column is named twice.");
  return rows.map((cells) => {
    const row: Record<string, unknown> = {};
    names.forEach((name, i) => {
      const cell = restoreCsvCell(cells[i] ?? "");
      if (cell.trim() !== "") row[name] = cell;
    });
    if (cells.length > names.length) row["__extra"] = true;
    return row as RawRow;
  });
}

const BOOL: Readonly<Record<string, boolean>> = {
  true: true,
  false: false,
  yes: true,
  no: false,
  "1": true,
  "0": false,
};

function bool(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const b = BOOL[value.trim().toLowerCase()];
    if (b !== undefined) return b;
  }
  throw new Error(`${field} must be true or false.`);
}

function tagsOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list =
    typeof value === "string"
      ? value.split(new RegExp(`[${SEMANTIC_MEMORY_CSV_TAG_SEPARATOR},]`, "u"))
      : Array.isArray(value)
        ? value
        : null;
  if (list === null) throw new Error("tags must be a list.");
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") throw new Error("tags must be text.");
    const tag = raw.trim().toLowerCase();
    if (tag === "" || out.includes(tag)) continue;
    if (!semanticMemoryTagSchema.safeParse(tag).success)
      throw new Error(`The tag "${tag.slice(0, 40)}" is too long or has control characters.`);
    out.push(tag);
  }
  return out;
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** One row checked against the field rules; a failure keeps what could be read. */
function toRow(raw: RawRow, index: number): ImportRow {
  const statementText = text(raw.statement);
  const kind = semanticMemoryKindSchema.safeParse(
    typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : raw.kind,
  );
  const base = {
    index,
    ref: typeof raw.ref === "string" && raw.ref.trim() !== "" ? raw.ref.trim() : null,
    kind: kind.success ? kind.data : null,
    statement: statementText,
    tags: [] as string[],
    pinned: false,
    policy: false,
    asOf: null as string | null,
    status: "active" as SemanticMemoryStatus,
    supersededBy:
      typeof raw.superseded_by === "string" && raw.superseded_by.trim() !== ""
        ? raw.superseded_by.trim()
        : null,
  };
  try {
    if ((raw as Record<string, unknown>)["__extra"]) throw new Error("The row has extra cells.");
    const statement = semanticMemoryStatementSchema.safeParse(statementText);
    if (!statement.success)
      throw new Error(
        statementText.trim() === ""
          ? "The statement is empty."
          : (statement.error.issues[0]?.message ?? "The statement can't be read."),
      );
    if (raw.kind === undefined) throw new Error("The kind is missing.");
    if (!kind.success)
      throw new Error("The kind must be preference, fact, convention, definition or decision.");
    const status = semanticMemoryStatusSchema.safeParse(
      raw.status === undefined ? "active" : raw.status,
    );
    if (!status.success) throw new Error("The status must be active, archived or superseded.");
    const asOf =
      raw.as_of === undefined || raw.as_of === null
        ? null
        : semanticMemoryDateSchema.parse(raw.as_of);
    return {
      ...base,
      tags: tagsOf(raw.tags),
      // Archiving unpins, so only an active row keeps its pin.
      pinned: bool(raw.pinned, "pinned") && status.data === "active",
      policy: bool(raw.policy, "policy"),
      asOf,
      status: status.data,
      error: null,
    };
  } catch (err) {
    const message =
      err instanceof Error && !("issues" in err)
        ? err.message
        : "as_of must be a date (YYYY-MM-DD).";
    return { ...base, error: message };
  }
}
