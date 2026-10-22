"use client";

/**
 * A workspace text file rendered (KOBE-268; the editor's Rendered mode, KOBE-463): the artifact
 * views reused. Markdown, CSV/TSV tables, JSON pretty-printed, code and text as fenced blocks.
 */
import { fenced } from "../../lib/chat/artifacts";
import type { FilePreview } from "../../lib/files/preview";
import { CsvTable } from "../chat/csv-table";
import { Markdown } from "../chat/markdown";

/** JSON pretty-printed; a cut or invalid file as it is. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
}

export function TextView({
  text,
  preview,
}: {
  readonly text: string;
  readonly preview: FilePreview;
}) {
  switch (preview.kind) {
    case "markdown":
      return <Markdown text={text} />;
    case "csv":
    case "tsv":
      return <CsvTable text={text} delimiter={preview.kind === "tsv" ? "\t" : ","} />;
    case "json":
      return <Markdown text={fenced(prettyJson(text), "json")} />;
    case "code":
      return <Markdown text={fenced(text, preview.language)} />;
    default:
      return <Markdown text={fenced(text, null)} />;
  }
}
