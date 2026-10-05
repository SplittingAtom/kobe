import type { Readable } from "node:stream";
import { ARTIFACT_CONTENT_MAX_BYTES, type ArtifactKind } from "@kobe/protocol";
import { threadKey, type BlobStore } from "../retention/blobs.js";

/** Pure helpers of the artifact routes: file names, the iframe document and its headers. */

/** File extension of an artifact's kind (export names, download names). */
const LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  python: "py",
  javascript: "js",
  typescript: "ts",
  tsx: "tsx",
  jsx: "jsx",
  json: "json",
  yaml: "yaml",
  bash: "sh",
  shell: "sh",
  sh: "sh",
  sql: "sql",
  css: "css",
  html: "html",
  rust: "rs",
  go: "go",
  java: "java",
  c: "c",
  "c++": "cpp",
  "c#": "cs",
  ruby: "rb",
  php: "php",
  r: "r",
};

export function artifactExtension(kind: ArtifactKind | string, language: string | null): string {
  switch (kind) {
    case "html":
      return "html";
    case "svg":
      return "svg";
    case "markdown":
      return "md";
    case "mermaid":
      return "mmd";
    case "csv":
      return "csv";
    default:
      return (language !== null && LANGUAGE_EXTENSIONS[language]) || "txt";
  }
}

/** `title` as a safe ASCII file stem (the download name and the export's names). */
export function fileStem(title: string): string {
  const s = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s === "" ? "artifact" : s;
}

/**
 * The frame route's headers (D-6): an opaque origin (CSP `sandbox` without `allow-same-origin`),
 * no network, nothing but inline script and style, data/blob media. `X-Frame-Options: SAMEORIGIN`
 * is set on this route only; every other route stays unframeable.
 */
export const FRAME_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; " +
    "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; " +
    "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

/** An SVG as a minimal HTML document (the frame route serves HTML only). */
export function svgDocument(svg: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<style>html,body{margin:0;height:100%}body{display:flex;align-items:center;" +
    "justify-content:center}svg{max-width:100%;max-height:100%}</style></head>" +
    `<body>${svg}</body></html>`
  );
}

/**
 * The version's bytes from the thread's own object tree, capped at the artifact size limit;
 * undefined when the object is missing, outside the tree or too large (nothing is served then).
 */
export async function readArtifactBytes(
  blobs: BlobStore,
  teamId: string,
  threadId: string,
  key: string,
): Promise<Buffer | undefined> {
  if (!threadKey(blobs.prefix, teamId, threadId, key)) return undefined;
  const object = await blobs.objects.get(key);
  if (!object) return undefined;
  if (object.size > ARTIFACT_CONTENT_MAX_BYTES) {
    object.body.destroy();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of object.body as Readable) {
    const b = Buffer.from(chunk as Uint8Array);
    bytes += b.length;
    if (bytes > ARTIFACT_CONTENT_MAX_BYTES) {
      object.body.destroy();
      return undefined;
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
