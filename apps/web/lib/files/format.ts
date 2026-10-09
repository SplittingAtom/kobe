import type { ApiError } from "../api/client";

/** Server-owned areas of `/workspace` (D-file-browser): read-only for the user and the agent. */
const READ_ONLY_ROOTS: ReadonlySet<string> = new Set(["uploads", "projects"]);

export function isReadOnlyPath(path: string): boolean {
  return READ_ONLY_ROOTS.has(path.split("/")[0] ?? "");
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && !Number.isInteger(value) ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const LEGAL_HOLD = "Your workspace is under a legal hold, so nothing can be deleted.";

/**
 * The words for a file API error. `legal_hold` is the code KOBE-184 introduces; until it lands the
 * server answers a held delete as 409 `read_only`, which the 403 `read_only` of the areas is not.
 */
export function describeFileError(error: ApiError): ApiError {
  if (error.code === "legal_hold" || (error.code === "read_only" && error.status === 409)) {
    return { ...error, message: LEGAL_HOLD };
  }
  if (error.code === "read_only") {
    return { ...error, message: "Project files and uploads are read-only here." };
  }
  if (error.code === "file_too_large") {
    return { ...error, message: `That file is too large to upload. ${error.message}` };
  }
  if (error.code === "quota_exceeded") {
    return { ...error, message: "Your workspace is full. Delete something and try again." };
  }
  return error;
}
