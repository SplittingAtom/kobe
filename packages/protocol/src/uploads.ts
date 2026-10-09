import { z } from "zod";
import { timestampSchema, uuidSchema } from "./common.js";

/**
 * Uploads contract (KOBE-141 = 53a of KOBE-53, spec D26; wire shape in docs/ledger/KOBE-141.md).
 * Additive: nothing here changes an existing frame or body for callers that send no files.
 *
 * Flow: the web client `POST /v1/uploads` (multipart/form-data: optional text field `thread_id`
 * per {@link uploadFieldsSchema}, then exactly one file part; the server streams it to S3, scans it
 * if ClamAV is on, and answers {@link uploadResponseSchema}) -> the client lists the returned
 * `file_id`s in `file_ids` of `POST /v1/threads/{id}/messages` (`submitMessageBodySchema`) -> before
 * the run starts the server syncs the files into `/workspace/uploads/<thread>/` and sends them in
 * `run.start.attachments` ({@link sandboxAttachmentSchema}, sandbox-wire/frames.ts). Uploads are
 * private to the uploading user; an unknown or foreign `file_id` is a 404 on submit.
 * Errors use {@link uploadErrorSchema}; any other failure uses the platform's usual error body.
 */

const MIB = 1024 * 1024;

/**
 * Install-wide defaults (D26: 100 MB per file, 500 MB per message). The server may configure other
 * values (Helm), but never above the per-message count {@link UPLOAD_MAX_FILES_PER_MESSAGE}; the
 * effective limits are reported in `limit_bytes` of the error, not negotiated up front.
 */
export const UPLOAD_DEFAULT_MAX_FILE_BYTES = 100 * MIB;
export const UPLOAD_DEFAULT_MAX_MESSAGE_BYTES = 500 * MIB;
/** Hard cap on `file_ids` per message and on `run.start.attachments`. Not configurable. */
export const UPLOAD_MAX_FILES_PER_MESSAGE = 100;
/** Any file type is accepted (D26); the server never rejects on `mime_type` or extension. */
export const UPLOAD_FILE_NAME_MAX = 255;

/** Directory in the sandbox where uploads are synced: `/workspace/uploads/<thread>/<name>`. */
export const UPLOAD_ATTACHMENT_ROOT = "/workspace/uploads";

const hasControlChar = (s: string): boolean =>
  [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** A single path segment: no separators, no control characters, not `.` or `..`. */
export const uploadFileNameSchema = z
  .string()
  .min(1)
  .max(UPLOAD_FILE_NAME_MAX)
  .refine((s) => s !== "." && s !== ".." && !/[/\\]/.test(s), "invalid file name")
  .refine((s) => !hasControlChar(s), "control character in file name");

/** Text fields of the multipart request. `thread_id` absent = not tied to a thread yet. */
export const uploadFieldsSchema = z.strictObject({ thread_id: uuidSchema.optional() });
export type UploadFields = z.infer<typeof uploadFieldsSchema>;

/** `skipped` = ClamAV is off; `clean` = scanned. Infected or unscanned files are errors, not stored. */
export const UPLOAD_SCAN_STATES = ["skipped", "clean"] as const;

/** 201 response of `POST /v1/uploads`. */
export const uploadResponseSchema = z.strictObject({
  file_id: uuidSchema,
  name: uploadFileNameSchema,
  mime_type: z.string().min(1).max(255),
  size_bytes: z.number().int().nonnegative(),
  scan: z.enum(UPLOAD_SCAN_STATES),
  created_at: timestampSchema,
});
export type UploadResponse = z.infer<typeof uploadResponseSchema>;

/**
 * Error codes of `POST /v1/uploads` and of message submit with `file_ids`.
 * `message_too_large` and `quota_exceeded` can also come from submit (sum of the files' sizes).
 */
export const UPLOAD_ERROR_CODES = [
  "file_too_large",
  "message_too_large",
  "quota_exceeded",
  "scan_rejected",
  "scan_unavailable",
] as const;
export const uploadErrorCodeSchema = z.enum(UPLOAD_ERROR_CODES);
export type UploadErrorCode = z.infer<typeof uploadErrorCodeSchema>;

/** `scan_unavailable` (ClamAV on but unreachable) is retryable; the file is not stored. */
export const UPLOAD_ERROR_HTTP_STATUS = {
  file_too_large: 413,
  message_too_large: 413,
  quota_exceeded: 403,
  scan_rejected: 422,
  scan_unavailable: 503,
} as const satisfies Record<UploadErrorCode, number>;

export const uploadErrorSchema = z.strictObject({
  code: uploadErrorCodeSchema,
  message: z.string().max(2000),
  /** The limit that was exceeded, for `file_too_large` and `message_too_large`. */
  limit_bytes: z.number().int().positive().optional(),
});
export type UploadError = z.infer<typeof uploadErrorSchema>;
