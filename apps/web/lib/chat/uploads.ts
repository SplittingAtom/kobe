/**
 * Uploads from the composer (KOBE-145; contract in `@kobe/protocol` uploads.ts, KOBE-141):
 * `POST /v1/uploads` multipart, one file per request, progress from XHR. Limits are the install
 * defaults, used only for client-side pre-checks; the server's own limit (`limit_bytes` in the
 * error) is what a refusal reports.
 */
import {
  UPLOAD_DEFAULT_MAX_FILE_BYTES,
  UPLOAD_DEFAULT_MAX_MESSAGE_BYTES,
  UPLOAD_MAX_FILES_PER_MESSAGE,
  uploadErrorSchema,
  uploadResponseSchema,
} from "@kobe/protocol";
import { TEAM_HEADER } from "../teams";

export const MAX_FILE_BYTES = UPLOAD_DEFAULT_MAX_FILE_BYTES;
export const MAX_MESSAGE_BYTES = UPLOAD_DEFAULT_MAX_MESSAGE_BYTES;
export const MAX_FILES = UPLOAD_MAX_FILES_PER_MESSAGE;

export interface UploadedFile {
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface UploadFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type UploadOutcome =
  | { readonly ok: true; readonly file: UploadedFile }
  | { readonly ok: false; readonly error: UploadFailure };

export interface UploadRequest {
  readonly teamId: string;
  readonly file: File;
  readonly threadId?: string | undefined;
  readonly onProgress: (fraction: number) => void;
  readonly signal: AbortSignal;
}

/** Sends one file; never throws. Replaceable in tests. */
export type UploadTransport = (request: UploadRequest) => Promise<UploadOutcome>;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Plain-language text for an upload or submit refusal; `limitBytes` is the server's limit if sent. */
export function uploadErrorMessage(code: string, limitBytes?: number): string | undefined {
  const limit = limitBytes === undefined ? undefined : formatBytes(limitBytes);
  switch (code) {
    case "file_too_large":
      return `This file is larger than the ${limit ?? formatBytes(MAX_FILE_BYTES)} limit for one file.`;
    case "message_too_large":
      return `The files on this message add up to more than the ${limit ?? formatBytes(MAX_MESSAGE_BYTES)} limit. Remove some.`;
    case "quota_exceeded":
      return "Your team's storage is full. Ask an admin to free space or raise the quota.";
    case "scan_rejected":
      return "The virus scan rejected this file, so it was not uploaded.";
    case "scan_unavailable":
      return "The virus scanner is unavailable right now. Try again in a moment.";
    default:
      return undefined;
  }
}

/** Why `file` can't be added to a message that already holds `existing` files, or undefined. */
export function precheck(
  file: Pick<File, "name" | "size">,
  existing: readonly { readonly size: number }[],
): UploadFailure | undefined {
  if (file.size > MAX_FILE_BYTES) {
    return fail("file_too_large", uploadErrorMessage("file_too_large"));
  }
  if (existing.length >= MAX_FILES) {
    return fail("too_many_files", `A message can carry at most ${MAX_FILES} files.`);
  }
  const total = existing.reduce((sum, f) => sum + f.size, 0) + file.size;
  if (total > MAX_MESSAGE_BYTES) {
    return fail("message_too_large", uploadErrorMessage("message_too_large"));
  }
  return undefined;
}

function fail(code: string, message: string | undefined): UploadFailure {
  return { code, message: message ?? "The upload failed.", retryable: false };
}

function failureFrom(status: number, body: unknown): UploadFailure {
  const parsed = uploadErrorSchema.safeParse(body);
  if (parsed.success) {
    const { code, limit_bytes } = parsed.data;
    return {
      code,
      message: uploadErrorMessage(code, limit_bytes) ?? parsed.data.message,
      retryable: code === "scan_unavailable",
    };
  }
  if (status === 401) return fail("unauthenticated", "Your session has ended. Sign in again.");
  if (status === 403) return fail("forbidden", "You don't have permission to upload here.");
  if (status === 404) return fail("not_found", "This conversation no longer exists.");
  return {
    code: "upload_failed",
    message:
      status === 0
        ? "Kobe is unreachable. Check your connection and try again."
        : `The upload failed (HTTP ${status}). Try again.`,
    retryable: true,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The browser transport: XHR, because `fetch` reports no upload progress. */
export const xhrUploadTransport: UploadTransport = ({
  teamId,
  file,
  threadId,
  onProgress,
  signal,
}) =>
  new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const done = (error: UploadFailure) => resolve({ ok: false, error });
    xhr.open("POST", "/v1/uploads");
    xhr.setRequestHeader(TEAM_HEADER, teamId);
    xhr.setRequestHeader("accept", "application/json");
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => done(failureFrom(0, undefined));
    xhr.onabort = () => done(fail("aborted", "The upload was cancelled."));
    xhr.onload = () => {
      const body = parseJson(xhr.responseText);
      const ok = xhr.status >= 200 && xhr.status < 300;
      const parsed = ok ? uploadResponseSchema.safeParse(body) : undefined;
      if (parsed?.success) {
        const r = parsed.data;
        resolve({
          ok: true,
          file: { fileId: r.file_id, name: r.name, mimeType: r.mime_type, sizeBytes: r.size_bytes },
        });
      } else done(failureFrom(ok ? 500 : xhr.status, body));
    };
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    const form = new FormData();
    if (threadId !== undefined) form.append("thread_id", threadId);
    form.append("file", file, file.name);
    xhr.send(form);
  });

export interface AttachedFileRef {
  readonly name: string;
  readonly mimeType: string;
}

const ATTACHED = /\n\nAttached files:\n((?:- \S.* \([^()\n]*\)(?: - [^\n]*)?\n?)+)$/u;
const ATTACHED_LINE = /^- (.+) \(([^()\n]*)\)(?: - .*)?$/u;

/**
 * A submitted message as Pi stored it: the sandbox appends an "Attached files:" list to the text
 * (`promptWithAttachments`). Splits it back into the user's text and the files, for chips.
 */
export function splitAttachedFiles(text: string): {
  readonly text: string;
  readonly files: readonly AttachedFileRef[];
} {
  const match = ATTACHED.exec(text);
  if (!match) return { text, files: [] };
  const files: AttachedFileRef[] = [];
  for (const line of (match[1] ?? "").split("\n")) {
    const m = ATTACHED_LINE.exec(line);
    if (m) files.push({ name: (m[1] ?? "").split("/").at(-1) ?? "", mimeType: m[2] ?? "" });
  }
  return files.length === 0 ? { text, files: [] } : { text: text.slice(0, match.index), files };
}
