/**
 * Reading an import in the browser (KOBE-385, SM21) before it is sent for the preview. The
 * consoles take Markdown bullets (`- [kind] statement #tag`), CSV (`statement, kind, tags,
 * pinned`, a header row first) or a JSON export, at most {@link IMPORT_UI_MAX_ROWS} rows (the API
 * takes 1,000; the consoles keep previews reviewable). Markdown is turned into a JSON export
 * document (the API reads JSON and CSV); CSV and JSON go as they are. Nothing is checked here
 * beyond the shape: the server's preview runs every save check.
 */
import { SEMANTIC_MEMORY_EXPORT_FORMAT } from "@kobe/protocol";
import { parseCsv } from "../chat/artifacts";

export const IMPORT_UI_MAX_ROWS = 200;

export const IMPORT_FORMATS = ["markdown", "csv", "json"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** What the preview and commit send: the API's format and content. */
export interface ImportFile {
  readonly format: "json" | "csv";
  readonly content: string;
  readonly rows: number;
}

export type ReadResult =
  | { readonly ok: true; readonly file: ImportFile }
  | { readonly ok: false; readonly message: string };

const BULLET = /^\s*[-*+]\s+(.*)$/u;
const KIND = /^\[([^\]]*)\]\s*/u;
const TRAILING_TAG = /\s+#([^\s#]+)$/u;

/** One bullet: `[kind] statement #tag #tag` (kind and tags optional; tags only at the end). */
export function bulletItem(text: string): { kind?: string; statement: string; tags: string[] } {
  let rest = text.trim();
  const kind = KIND.exec(rest);
  if (kind) rest = rest.slice(kind[0].length);
  const tags: string[] = [];
  for (let m = TRAILING_TAG.exec(rest); m; m = TRAILING_TAG.exec(rest)) {
    tags.unshift((m[1] ?? "").toLowerCase());
    rest = rest.slice(0, m.index);
  }
  // A line that is only tags keeps its text (the server reports it).
  return {
    ...(kind ? { kind: (kind[1] ?? "").trim().toLowerCase() } : {}),
    statement: rest.trim(),
    tags,
  };
}

/** Markdown bullets as a JSON export document; other lines (headings, notes) are skipped. */
export function markdownToJson(text: string): { content: string; rows: number } {
  const items = text
    .split(/\r?\n/u)
    .map((line) => BULLET.exec(line)?.[1])
    .filter((b): b is string => b !== undefined && b.trim() !== "")
    .map(bulletItem);
  return {
    content: JSON.stringify({ format: SEMANTIC_MEMORY_EXPORT_FORMAT, items }),
    rows: items.length,
  };
}

/** The format a file name suggests, else what the text looks like. */
export function guessFormat(name: string | null, text: string): ImportFormat {
  const ext = name?.toLowerCase().split(".").pop();
  if (ext === "csv") return "csv";
  if (ext === "json") return "json";
  if (ext === "md" || ext === "markdown" || ext === "txt") return "markdown";
  const start = text.trimStart();
  if (start.startsWith("{")) return "json";
  if (BULLET.test(start.split(/\r?\n/u)[0] ?? "")) return "markdown";
  return /^[^\n]*statement[^\n]*,/iu.test(start) ? "csv" : "markdown";
}

const tooMany = (n: number): ReadResult => ({
  ok: false,
  message: `This file has ${n} rows. Import at most ${IMPORT_UI_MAX_ROWS} at a time: split it and import each part.`,
});

/** Reads the text as `format` into what the API takes, or says why it can't be sent. */
export function readImport(format: ImportFormat, text: string): ReadResult {
  if (text.trim() === "") return { ok: false, message: "Paste or choose a file first." };
  if (format === "markdown") {
    const { content, rows } = markdownToJson(text);
    if (rows === 0)
      return { ok: false, message: "No bullets found. Write one memory per line: - [fact] text" };
    return rows > IMPORT_UI_MAX_ROWS
      ? tooMany(rows)
      : { ok: true, file: { format: "json", content, rows } };
  }
  if (format === "csv") {
    const rows = Math.max(0, parseCsv(text).length - 1);
    if (rows === 0)
      return {
        ok: false,
        message: "No rows found. The first line names the columns: statement,kind,tags,pinned",
      };
    return rows > IMPORT_UI_MAX_ROWS
      ? tooMany(rows)
      : { ok: true, file: { format: "csv", content: text, rows } };
  }
  let items: unknown;
  try {
    items = (JSON.parse(text) as { items?: unknown }).items;
  } catch {
    return { ok: false, message: "This is not valid JSON. Use a Kobe memory export." };
  }
  if (!Array.isArray(items)) return { ok: false, message: "This is not a Kobe memory export." };
  return items.length > IMPORT_UI_MAX_ROWS
    ? tooMany(items.length)
    : { ok: true, file: { format: "json", content: text, rows: items.length } };
}
