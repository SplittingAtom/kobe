/**
 * Artifacts in the web app (KOBE-130, D-6/D-7 of docs/ledger/KOBE-55.md). The API answers in
 * snake_case; `apiRequest` camelizes, so these are the camelized shapes of `ArtifactSummary` /
 * `ArtifactDetail` (`@kobe/protocol`).
 */
import type { ArtifactKind } from "@kobe/protocol";

export type { ArtifactKind };

export interface ArtifactSummaryView {
  readonly id: string;
  readonly threadId: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly language: string | null;
  readonly currentVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArtifactVersionView {
  readonly version: number;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export interface ArtifactDetailView extends ArtifactSummaryView {
  readonly versions: readonly ArtifactVersionView[];
}

const enc = encodeURIComponent;

/** Kinds shown in the sandboxed frame (D-7); every other kind is rendered in the panel. */
export function isFrameKind(kind: ArtifactKind): boolean {
  return kind === "html" || kind === "svg";
}

/**
 * The download URL of one version (D-6). A link can't send `X-Kobe-Team`, so the team goes in the
 * query, like `threadExportUrl`.
 */
export function artifactContentUrl(artifactId: string, version: number, teamId: string): string {
  return `/v1/artifacts/${enc(artifactId)}/versions/${version}/content?team=${enc(teamId)}`;
}

/** The document the panel's iframe loads (D-6/D-7: its own CSP, never `srcdoc`). */
export function artifactFrameUrl(artifactId: string, version: number, teamId: string): string {
  return `/v1/artifacts/${enc(artifactId)}/versions/${version}/frame?team=${enc(teamId)}`;
}

/** The iframe's sandbox: scripts and forms, never `allow-same-origin` (opaque origin, D25). */
export const ARTIFACT_FRAME_SANDBOX = "allow-scripts allow-forms";

/** RFC 4180-style CSV: quoted fields, doubled quotes, CRLF or LF rows. Never throws. */
export function parseCsv(text: string): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = "";
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"' && text.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text.charAt(i + 1) === "\n") i += 1;
      endRow();
    } else field += c;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** A fence long enough that the content can't close it. */
export function fenced(content: string, language: string | null): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language ?? ""}\n${content}\n${fence}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The artifact id in the result of `create_artifact` / `update_artifact`, when it is there. */
export function artifactIdFromToolResult(result: unknown): string | undefined {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as { artifact_id?: unknown }).artifact_id;
  return typeof id === "string" && UUID.test(id) ? id : undefined;
}

export const ARTIFACT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create_artifact",
  "update_artifact",
]);
