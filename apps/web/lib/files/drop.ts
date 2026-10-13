/**
 * Files dropped on the workspace rail (CE5, KOBE-199): they land in `/workspace/uploads/` through
 * the workspace files API and sync on the next run. Never attached to a message (the composer is
 * the attach path, KOBE-145).
 */
import type { ApiError } from "../api/client";
import type { FilesApi } from "./api";
import { describeFileError } from "./format";

export const DROP_FOLDER = "uploads";
/** Copies tried after a name clash: "name (1).ext" .. "name (9).ext". */
const MAX_COPIES = 9;

export interface DroppedItems {
  readonly files: readonly File[];
  /** Folders cannot be uploaded (the API takes one file per request); named in the notice. */
  readonly folders: readonly string[];
}

export interface DropOutcome {
  /** The names the files were stored under, in order. */
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

/** "report.pdf" -> "report (1).pdf"; a leading dot is part of the name (".env" -> ".env (1)"). */
export function copyName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

export function folderError(folders: readonly string[]): ApiError {
  return {
    status: 400,
    code: "folder_dropped",
    message: `Folders can't be added to your workspace (${folders.join(", ")}). Drop the files inside them instead.`,
  };
}

/** One file into uploads/; a name clash tries "name (1).ext" and so on, never overwriting. */
async function uploadOne(api: FilesApi, file: File): Promise<{ name: string } | ApiError> {
  for (let n = 0; n <= MAX_COPIES; n += 1) {
    const name = n === 0 ? file.name : copyName(file.name, n);
    const res = await api.upload(DROP_FOLDER, file, name);
    if (res.ok) return { name };
    if (res.error.code !== "already_exists") return res.error;
  }
  return {
    status: 409,
    code: "already_exists",
    message: "Too many files with this name are already in uploads.",
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
    const res = await uploadOne(api, file);
    if ("name" in res) {
      added.push(res.name);
      continue;
    }
    const described = describeFileError(res);
    errors.push({ ...described, message: `${file.name}: ${described.message}` });
    if (res.code === "quota_exceeded") break;
  }
  return { added, errors };
}
