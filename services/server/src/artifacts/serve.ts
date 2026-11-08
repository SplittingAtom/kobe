import type { Readable } from "node:stream";
import {
  ARTIFACT_CONTENT_MAX_BYTES,
  artifactFileExtension,
  artifactFileStem,
} from "@kobe/protocol";
import { threadKey, type BlobStore } from "../retention/blobs.js";

/** Pure helpers of the artifact routes: file names, the iframe document and its headers. */

/** File extension of an artifact (export names, download names, Edit as file): shared with the web. */
export const artifactExtension = artifactFileExtension;

/** `title` as a safe ASCII file stem: shared with the web (Add to project names). */
export const fileStem = artifactFileStem;

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

/** Browsers mark a navigation another site started; a frame must come from Kobe's own page. */
const SAME_SITE_FETCH = new Set(["same-origin", "none"]);

/**
 * Whether a frame request comes from Kobe's own page (D-6): `Sec-Fetch-Site`, when sent, is
 * same-origin or none, and `Origin`, when sent, is Kobe's public URL.
 */
export function isSameSiteFrameRequest(headers: Headers, publicUrl: string): boolean {
  const site = headers.get("sec-fetch-site");
  const origin = headers.get("origin");
  return (site === null || SAME_SITE_FETCH.has(site)) && (origin === null || origin === publicUrl);
}

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
 * A body read to the end, or "too_large" (the stream destroyed) once it passes `maxBytes`. A
 * stream error rejects; callers log it with their context. Shared by the artifact and workspace
 * frame routes.
 */
export async function readCappedBody(
  body: Readable,
  maxBytes: number,
): Promise<Buffer | "too_large"> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    const b = Buffer.from(chunk as Uint8Array);
    bytes += b.length;
    if (bytes > maxBytes) {
      body.destroy();
      return "too_large";
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/**
 * The version's bytes from the thread's own object tree, capped at the artifact size limit, or why
 * not: `missing` (no object, or a key outside the thread's tree) or `too_large`. A storage error
 * throws.
 */
export async function readArtifactVersion(
  blobs: BlobStore,
  teamId: string,
  threadId: string,
  key: string,
): Promise<Buffer | "missing" | "too_large"> {
  if (!threadKey(blobs.prefix, teamId, threadId, key)) return "missing";
  const object = await blobs.objects.get(key);
  if (!object) return "missing";
  if (object.size > ARTIFACT_CONTENT_MAX_BYTES) {
    object.body.destroy();
    return "too_large";
  }
  return readCappedBody(object.body, ARTIFACT_CONTENT_MAX_BYTES);
}

/** {@link readArtifactVersion}, undefined when nothing is served (missing or too large). */
export async function readArtifactBytes(
  blobs: BlobStore,
  teamId: string,
  threadId: string,
  key: string,
): Promise<Buffer | undefined> {
  const read = await readArtifactVersion(blobs, teamId, threadId, key);
  return typeof read === "string" ? undefined : read;
}
