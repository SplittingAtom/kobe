/**
 * Workspace files in the artifact column (KOBE-268): tab ids, how a file is previewed (by its
 * extension), the size caps and the frame URL. Pure; the viewer is `components/files/file-tab.tsx`.
 */

/** File tabs share the column's open set with artifact tabs (uuids), so they carry a prefix. */
const FILE_TAB_PREFIX = "file:";
/** The protocol's `WORKSPACE_PATH_MAX_BYTES`, counted in characters here (the server checks). */
const PATH_MAX = 1024;

/** Text previews (Markdown, CSV, JSON, code) read at most this much, then say so. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** Images larger than this are not fetched at all: Download instead. */
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
/** The server's frame cap (`WORKSPACE_FRAME_MAX_BYTES`): larger HTML files are not framed. */
export const HTML_FRAME_MAX_BYTES = 1024 * 1024;

export function fileTabId(path: string): string {
  return `${FILE_TAB_PREFIX}${path}`;
}

/** The workspace path of a file tab; null for an artifact tab or a garbled (stored) id. */
export function filePathOfTab(id: string): string | null {
  if (!id.startsWith(FILE_TAB_PREFIX)) return null;
  const path = id.slice(FILE_TAB_PREFIX.length);
  if (path === "" || path.length > PATH_MAX || path.startsWith("/")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(path)) return null;
  return path.split("/").some((s) => s === "" || s === "." || s === "..") ? null : path;
}

/**
 * A tab id as part of a DOM id (no whitespace, for `aria-controls`): anything but letters, digits
 * and `-` becomes `_<hex>_`, so two different tabs never share one.
 */
export function tabDomId(id: string): string {
  return id.replace(/[^A-Za-z0-9-]/g, (c) => `_${(c.codePointAt(0) ?? 0).toString(16)}_`);
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export type FilePreview =
  | { readonly kind: "markdown" | "csv" | "tsv" | "json" | "text" | "html" | "none" }
  | { readonly kind: "code"; readonly language: string }
  | { readonly kind: "image" | "svg"; readonly mime: string };

const CODE: Readonly<Record<string, string>> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  css: "css",
  scss: "scss",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  r: "r",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  ipynb: "json",
};
const CODE_NAMES: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};
const TEXT = new Set(["txt", "log", "ini", "cfg", "conf", "env", "gitignore", "rst", "tex"]);
const IMAGES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const SIMPLE: Readonly<Record<string, FilePreview["kind"]>> = {
  md: "markdown",
  markdown: "markdown",
  csv: "csv",
  tsv: "tsv",
  json: "json",
  html: "html",
  htm: "html",
};

/** How a file is shown, by its extension. PDFs and anything unknown are `none` (Download). */
export function previewOf(path: string): FilePreview {
  const name = fileName(path).toLowerCase();
  const named = CODE_NAMES[name];
  if (named) return { kind: "code", language: named };
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot + 1);
  const simple = SIMPLE[ext];
  if (simple) return { kind: simple } as FilePreview;
  if (ext === "svg") return { kind: "svg", mime: "image/svg+xml" };
  const image = IMAGES[ext];
  if (image) return { kind: "image", mime: image };
  const language = CODE[ext];
  if (language) return { kind: "code", language };
  return { kind: TEXT.has(ext) ? "text" : "none" };
}

/**
 * Bytes as UTF-8 text, or null when they are not text (invalid UTF-8 or a NUL byte). A preview
 * cut at the cap may end inside a character: that tail is dropped, not an error.
 */
export function decodePreviewText(bytes: Uint8Array, truncated: boolean): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
  } catch {
    return null;
  }
}

/** An image as a `data:` URL (the page CSP's `img-src` is `'self' data:`; `<img>` never runs SVG script). */
export function imageDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** The document an HTML file's iframe loads (the server's frame route; never `srcdoc`). */
export function workspaceFrameUrl(path: string, teamId: string): string {
  return `/v1/workspace/frame?${new URLSearchParams({ path, team: teamId }).toString()}`;
}
