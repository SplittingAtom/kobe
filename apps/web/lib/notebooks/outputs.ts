/**
 * How a notebook output is shown (KOBE-465, docs/specs/notebooks.md NB4), decided here and pure:
 * - stream text, results and tracebacks as plain text, ANSI codes stripped (never interpreted);
 * - PNG/JPEG from their base64 and SVG re-encoded as `data:` URLs for an `<img>` (never inline
 *   SVG markup, which could run script; an `<img>` never does);
 * - a DataFrame's HTML table read into rows of plain text with an inert parser (`DOMParser`
 *   documents run no script and load nothing), and a table schema from `application/json`;
 * - any other HTML only in the sandboxed, network-less output frame (`output-frame.tsx`);
 * - Markdown through the chat's safe Markdown component.
 * Kernel HTML is never put into the page.
 */
import type { NotebookOutput } from "@kobe/protocol";

export type OutputView =
  | { readonly kind: "stream"; readonly name: "stdout" | "stderr"; readonly text: string }
  | { readonly kind: "error"; readonly title: string; readonly traceback: string }
  | { readonly kind: "image"; readonly src: string; readonly alt: string }
  | {
      readonly kind: "table";
      readonly header: readonly (readonly string[])[];
      readonly rows: readonly (readonly string[])[];
      readonly truncated: boolean;
    }
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "markdown" | "text"; readonly text: string }
  | { readonly kind: "unsupported" };

/** Parses HTML into an inert document (the browser's `DOMParser`); absent: no tables from HTML. */
export type HtmlParser = (html: string) => Document;

export const TABLE_MAX_ROWS = 500;
export const TABLE_MAX_COLUMNS = 100;

// CSI (colours, cursor moves), OSC (titles) and other two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/gu;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Terminal output as text: ANSI stripped, each line as its last carriage-return overwrite. */
export function terminalText(text: string): string {
  return stripAnsi(text)
    .split("\n")
    .map((line) => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      return trimmed.slice(trimmed.lastIndexOf("\r") + 1);
    })
    .join("\n");
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const cellText = (el: Element) => (el.textContent ?? "").trim();

/** A pandas DataFrame's `<table class="dataframe">` as rows of text; null for any other HTML. */
function dataFrameTable(html: string, parse: HtmlParser): OutputView | null {
  if (!/class="dataframe"/u.test(html)) return null;
  const table = parse(html).querySelector("table.dataframe");
  if (!table) return null;
  const row = (tr: Element) =>
    Array.from(tr.querySelectorAll("th, td"), cellText).slice(0, TABLE_MAX_COLUMNS);
  const header = Array.from(table.querySelectorAll("thead tr"), row);
  const body = Array.from(table.querySelectorAll("tbody tr"));
  return {
    kind: "table",
    header,
    rows: body.slice(0, TABLE_MAX_ROWS).map(row),
    truncated: body.length > TABLE_MAX_ROWS,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function plain(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A Table Schema `{schema: {fields}, data}` (pandas `table_schema`) as rows of text. */
function schemaTable(value: unknown): OutputView | null {
  if (!isRecord(value) || !isRecord(value.schema) || !Array.isArray(value.data)) return null;
  const fields = value.schema.fields;
  if (!Array.isArray(fields)) return null;
  const names = fields
    .map((f) => (isRecord(f) && typeof f.name === "string" ? f.name : null))
    .filter((n): n is string => n !== null)
    .slice(0, TABLE_MAX_COLUMNS);
  const records = value.data.filter(isRecord);
  return {
    kind: "table",
    header: [names],
    rows: records.slice(0, TABLE_MAX_ROWS).map((r) => names.map((n) => plain(r[n]))),
    truncated: records.length > TABLE_MAX_ROWS,
  };
}

function bundleView(data: Readonly<Record<string, unknown>>, parse?: HtmlParser): OutputView {
  const str = (mime: string) => (typeof data[mime] === "string" ? (data[mime] as string) : null);
  const html = str("text/html");
  if (html !== null && parse) {
    const table = dataFrameTable(html, parse);
    if (table) return table;
  }
  const json = data["application/json"];
  const schema = json === undefined ? null : schemaTable(json);
  if (schema) return schema;
  const alt = str("text/plain")?.trim() || "Output image";
  for (const mime of ["image/png", "image/jpeg"] as const) {
    const b64 = str(mime);
    if (b64 !== null)
      return { kind: "image", src: `data:${mime};base64,${b64.replace(/\s/gu, "")}`, alt };
  }
  const svg = str("image/svg+xml");
  if (svg !== null)
    return { kind: "image", src: `data:image/svg+xml;base64,${base64Utf8(svg)}`, alt };
  if (html !== null) return { kind: "html", html };
  const markdown = str("text/markdown");
  if (markdown !== null) return { kind: "markdown", text: markdown };
  if (json !== undefined) return { kind: "text", text: JSON.stringify(json, null, 2) };
  const text = str("text/latex") ?? str("text/plain");
  return text === null ? { kind: "unsupported" } : { kind: "text", text: terminalText(text) };
}

/** How one output is shown; null (a saved output that failed the protocol's check) cannot be. */
export function outputView(output: NotebookOutput | null, parse?: HtmlParser): OutputView {
  if (output === null) return { kind: "unsupported" };
  switch (output.output_type) {
    case "stream":
      return { kind: "stream", name: output.name, text: terminalText(output.text) };
    case "error":
      return {
        kind: "error",
        title: stripAnsi(`${output.ename}: ${output.evalue}`),
        traceback: output.traceback.map(terminalText).join("\n"),
      };
    case "display_data":
    case "execute_result":
      return bundleView(output.data as Readonly<Record<string, unknown>>, parse);
  }
}

/** The browser's inert HTML parser, when there is one. */
export function browserHtmlParser(): HtmlParser | undefined {
  if (typeof DOMParser === "undefined") return undefined;
  const parser = new DOMParser();
  return (html) => parser.parseFromString(html, "text/html");
}
