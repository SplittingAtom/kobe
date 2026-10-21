/**
 * The file editor (KOBE-463, spec docs/specs/file-editor.md): which workspace files open in it,
 * whether they open read-only, the language mode of the Raw view, and the version (SHA-256) a
 * save names. Pure; the editor is `components/files/file-editor.tsx` (CodeMirror loads lazily).
 */
import { formatBytes, isReadOnlyPath } from "./format";
import { TEXT_PREVIEW_MAX_BYTES, type FilePreview } from "./preview";

const TEXT_KINDS: ReadonlySet<FilePreview["kind"]> = new Set([
  "markdown",
  "csv",
  "tsv",
  "json",
  "code",
  "text",
]);

/** Text files get Rendered and Raw modes; images, HTML frames and unknown files do not. */
export function isTextPreview(preview: FilePreview): boolean {
  return TEXT_KINDS.has(preview.kind);
}

/**
 * Why a text file opens read-only, or undefined when it can be edited: project files and thread
 * uploads are read-only (FE2), and a read cut at the preview cap cannot be saved whole.
 */
export function editBlockReason(path: string, truncated: boolean): string | undefined {
  if (isReadOnlyPath(path)) return "Project files and thread uploads are read-only.";
  if (truncated) {
    return `This file is over ${formatBytes(TEXT_PREVIEW_MAX_BYTES)}, so it opens read-only.`;
  }
  return undefined;
}

export type EditorLanguage =
  | "markdown"
  | "json"
  | "csv"
  | "tsv"
  | "python"
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "yaml";

const CODE_LANGUAGES: Readonly<Record<string, EditorLanguage>> = {
  python: "python",
  javascript: "javascript",
  jsx: "jsx",
  typescript: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  json: "json",
};

/** The Raw view's language mode; null is plain text. */
export function editorLanguage(preview: FilePreview): EditorLanguage | null {
  switch (preview.kind) {
    case "markdown":
    case "json":
    case "csv":
    case "tsv":
      return preview.kind;
    case "code":
      return CODE_LANGUAGES[preview.language] ?? null;
    default:
      return null;
  }
}

/** The version of a file's content: SHA-256 as lowercase hex (the listing's `sha256`). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
