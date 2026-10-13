/**
 * Files dropped on the workspace rail (CE5, KOBE-199): they land in `/workspace/uploads/` through
 * the workspace files API and sync on the next run. Never attached to a message (the composer is
 * the attach path, KOBE-145).
 */
import { WORKSPACE_DROP_FOLDER } from "@kobe/protocol";
import type { ApiError } from "../api/client";
import type { FilesApi } from "./api";
import { describeFileError } from "./format";

export interface DroppedItems {
  readonly files: readonly File[];
  /** Folders cannot be uploaded (the API takes one file per request); named in the notice. */
  readonly folders: readonly string[];
}

export interface DropOutcome {
  /** The names the files were stored under, in order (the server picks a copy name on a clash). */
  readonly added: readonly string[];
  readonly errors: readonly ApiError[];
}

/** True while the drag carries files (not text or a link). */
export function carriesFiles(dt: DataTransfer | null): boolean {
  return dt !== null && Array.from(dt.types ?? []).includes("Files");
}

/** Splits a drop into files and folders. Must run inside the drop event (items expire after it). */
export function droppedItems(dt: DataTransfer): DroppedItems {
  const items = Array.from(dt.items ?? []).filter((item) => item.kind === "file");
  if (items.length === 0) return { files: Array.from(dt.files ?? []), folders: [] };
  const files: File[] = [];
  const folders: string[] = [];
  for (const item of items) {
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory) {
      folders.push(entry.name);
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, folders };
}

export function folderError(folders: readonly string[]): ApiError {
  return {
    status: 400,
    code: "folder_dropped",
    message: `Folders can't be added to your workspace (${folders.join(", ")}). Drop the files inside them instead.`,
  };
}

/**
 * Uploads one at a time, in order. A full workspace stops the rest (they could not fit either);
 * any other refusal is reported for its file and the others still go.
 */
export async function uploadDropped(api: FilesApi, files: readonly File[]): Promise<DropOutcome> {
  const added: string[] = [];
  const errors: ApiError[] = [];
  for (const file of files) {
    const res = await api.upload(WORKSPACE_DROP_FOLDER, file);
    if (res.ok) {
      added.push(res.data.name);
      continue;
    }
    const described = describeFileError(res.error);
    errors.push({ ...described, message: `${file.name}: ${described.message}` });
    if (res.error.code === "quota_exceeded") break;
  }
  return { added, errors };
}
