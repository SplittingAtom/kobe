/**
 * Import and export of semantic memory (`/v1/memory/semantic/import/*`, `/export`; KOBE-385,
 * contract KOBE-377 transfer.ts). Preview runs the deterministic save checks on every row and
 * stores nothing (no learning model, Q10); commit saves the accepted rows all or nothing.
 */
import type { SemanticMemoryScope } from "@kobe/protocol";
import { apiDownload, apiRequest, type ApiResult } from "../api/client";
import type { ImportFile } from "./import-file";
import type { ItemKind } from "./items-api";

export interface ImportIssue {
  readonly code: string;
  readonly message: string;
}

export interface ImportRow {
  readonly index: number;
  readonly status: "new" | "duplicate" | "warning" | "invalid" | "blocked";
  readonly kind: ItemKind | null;
  readonly statement: string;
  readonly tags: readonly string[];
  readonly pinned: boolean;
  readonly policy: boolean;
  readonly issues: readonly ImportIssue[];
}

export interface ImportPreview {
  readonly rows: readonly ImportRow[];
}

export interface ImportCommit {
  readonly created: number;
}

/**
 * How the consoles name a row (the ticket's six classes, plus a row that can't be read): only
 * `new` rows are clean and committed.
 */
export type RowClass =
  | "new"
  | "near-duplicate"
  | "conflict"
  | "policy-blocked"
  | "secret"
  | "lint-flagged"
  | "unreadable";

export const ROW_CLASS_LABELS: Readonly<Record<RowClass, string>> = {
  new: "New",
  "near-duplicate": "Near-duplicate",
  conflict: "Conflicts with Policy",
  "policy-blocked": "Blocked by Policy rules",
  secret: "Secret: never saved",
  "lint-flagged": "Flagged by checks",
  unreadable: "Can't be imported",
};

export function rowClass(row: ImportRow): RowClass {
  const codes = row.issues.map((i) => i.code);
  switch (row.status) {
    case "new":
      return "new";
    case "duplicate":
      return "near-duplicate";
    case "blocked":
      return "secret";
    case "warning":
      return codes.includes("policy_conflict") ? "conflict" : "lint-flagged";
    case "invalid":
      return codes.some((c) => c.startsWith("policy_")) ? "policy-blocked" : "unreadable";
  }
}

const PREVIEW = "/v1/memory/semantic/import/preview";
const COMMIT = "/v1/memory/semantic/import/commit";

export interface TransferApi {
  preview(scope: SemanticMemoryScope, file: ImportFile): Promise<ApiResult<ImportPreview>>;
  commit(
    scope: SemanticMemoryScope,
    file: ImportFile,
    accept: readonly number[],
  ): Promise<ApiResult<ImportCommit>>;
  /** The export file's bytes (audited by the server). */
  exportScope(
    scope: SemanticMemoryScope,
    format: "json" | "csv",
    includeInactive: boolean,
  ): Promise<ApiResult<Uint8Array>>;
}

export function createTransferApi(teamId: string | undefined, fetchFn?: typeof fetch): TransferApi {
  const body = (scope: SemanticMemoryScope, file: ImportFile) => ({
    scope,
    format: file.format,
    content: file.content,
  });
  return {
    preview: (scope, file) =>
      apiRequest(PREVIEW, { method: "POST", json: body(scope, file), teamId, fetchFn }),
    commit: (scope, file, accept) =>
      apiRequest(COMMIT, {
        method: "POST",
        json: { ...body(scope, file), accept },
        teamId,
        fetchFn,
        errorDetails: true,
      }),
    // A POST: an export writes an audit row (review-385 L-4).
    exportScope: (scope, format, includeInactive) =>
      apiDownload("/v1/memory/semantic/export", {
        teamId,
        fetchFn,
        json: { scope, format, ...(includeInactive ? { include_inactive: true } : {}) },
      }),
  };
}

/** The file name an export is saved under. */
export const exportFileName = (scope: SemanticMemoryScope, format: "json" | "csv", day: string) =>
  `kobe-memories-${scope === "team" ? "workspace" : scope}-${day}.${format}`;
