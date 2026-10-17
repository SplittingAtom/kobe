/**
 * File-type icons of the Files tree (KOBE-304): one place maps a file's name (extension, a few
 * well-known names) and, failing that, its MIME type to a kind, and a kind to a lucide icon. Icons
 * are shapes, never colour-coded: they take the row's text colour, and the kind's words are in the
 * row's tooltip, so nothing depends on seeing colour (or the icon) at all.
 */
import {
  BookOpenTextIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileBracesIcon,
  FileCodeIcon,
  FileCogIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTerminalIcon,
  FileTextIcon,
  FileTypeIcon,
  FileVideoCameraIcon,
  FolderIcon,
  FolderLockIcon,
  FolderOpenIcon,
  GlobeIcon,
  NotebookIcon,
  PresentationIcon,
  type LucideIcon,
} from "lucide-react";

export const FILE_KINDS = [
  "code",
  "shell",
  "json",
  "config",
  "markdown",
  "text",
  "pdf",
  "spreadsheet",
  "document",
  "presentation",
  "image",
  "audio",
  "video",
  "archive",
  "html",
  "notebook",
  "file",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** The kind's words, for the tooltip (and anything else that must not rely on the icon). */
export const FILE_KIND_LABELS: Readonly<Record<FileKind, string>> = {
  code: "Code",
  shell: "Shell script",
  json: "JSON",
  config: "Configuration",
  markdown: "Markdown",
  text: "Text",
  pdf: "PDF",
  spreadsheet: "Spreadsheet or table",
  document: "Document",
  presentation: "Presentation",
  image: "Image",
  audio: "Audio",
  video: "Video",
  archive: "Archive",
  html: "Web page",
  notebook: "Notebook",
  file: "File",
};

const ICONS: Readonly<Record<FileKind, LucideIcon>> = {
  code: FileCodeIcon,
  shell: FileTerminalIcon,
  json: FileBracesIcon,
  config: FileCogIcon,
  markdown: FileTypeIcon,
  text: FileTextIcon,
  pdf: BookOpenTextIcon,
  spreadsheet: FileSpreadsheetIcon,
  document: FileTextIcon,
  presentation: PresentationIcon,
  image: FileImageIcon,
  audio: FileAudioIcon,
  video: FileVideoCameraIcon,
  archive: FileArchiveIcon,
  html: GlobeIcon,
  notebook: NotebookIcon,
  file: FileIcon,
};

const group = (kind: FileKind, exts: string) => exts.split(" ").map((ext) => [ext, kind] as const);

/** By lowercased extension (without the dot). */
const BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map([
  ...group(
    "code",
    "ts tsx mts cts js jsx mjs cjs py pyi go rs rb php java kt kts scala swift c h cc cpp cxx hpp hh cs fs vb m mm r jl lua pl pm dart ex exs erl hs clj elm vue svelte sql graphql gql proto css scss sass less wasm zig nim",
  ),
  ...group("shell", "sh bash zsh fish ps1 bat cmd"),
  ...group("json", "json jsonl ndjson geojson"),
  ...group(
    "config",
    "yaml yml toml ini cfg conf env properties lock xml plist editorconfig gitignore gitattributes dockerignore npmrc nvmrc",
  ),
  ...group("markdown", "md markdown mdx rst"),
  ...group("text", "txt text log rtf tex"),
  ...group("pdf", "pdf"),
  ...group("spreadsheet", "csv tsv xlsx xls xlsm ods parquet feather arrow"),
  ...group("document", "docx doc odt pages epub"),
  ...group("presentation", "pptx ppt odp key"),
  ...group("image", "png jpg jpeg gif webp svg bmp ico tif tiff heic avif"),
  ...group("audio", "mp3 wav ogg oga flac m4a aac opus"),
  ...group("video", "mp4 mov webm mkv avi m4v ogv"),
  ...group("archive", "zip tar gz tgz bz2 xz 7z rar zst jar whl"),
  ...group("html", "html htm xhtml"),
  ...group("notebook", "ipynb"),
]);

/** Names that say what they are without an extension (lowercased). */
const BY_NAME: ReadonlyMap<string, FileKind> = new Map([
  ["dockerfile", "code"],
  ["makefile", "code"],
  ["justfile", "code"],
  ["gemfile", "code"],
  ["procfile", "config"],
  ["license", "text"],
  ["readme", "text"],
  ["changelog", "text"],
]);

function byMime(mime: string): FileKind {
  const type = mime.toLowerCase().split(";")[0]?.trim() ?? "";
  if (type === "application/pdf") return "pdf";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (type === "text/html") return "html";
  if (type === "text/markdown") return "markdown";
  if (type === "text/csv" || type.includes("spreadsheet") || type.includes("excel"))
    return "spreadsheet";
  if (type.includes("wordprocessing") || type === "application/msword") return "document";
  if (type.includes("presentation") || type.includes("powerpoint")) return "presentation";
  if (/^application\/(zip|gzip|x-tar|x-7z|x-bzip2|x-xz|zstd)/.test(type)) return "archive";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("text/")) return "text";
  return "file";
}

/** The kind of a file named `name` (its MIME type, when known, decides only when the name can't). */
export function fileKind(name: string, mime?: string): FileKind {
  const lower = name.toLowerCase();
  const named = BY_NAME.get(lower);
  if (named) return named;
  const dot = lower.lastIndexOf(".");
  // ".env", ".gitignore": a leading dot is the whole name, and its extension.
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  const kind = ext === "" ? undefined : BY_EXTENSION.get(ext);
  if (kind) return kind;
  if (lower.startsWith(".env")) return "config";
  return mime === undefined ? "file" : byMime(mime);
}

export function fileKindIcon(kind: FileKind): LucideIcon {
  return ICONS[kind];
}

/** A folder: open or closed; a read-only one (a project mount) carries a lock. */
export function folderIcon(open: boolean, readOnly: boolean): LucideIcon {
  if (readOnly) return FolderLockIcon;
  return open ? FolderOpenIcon : FolderIcon;
}
