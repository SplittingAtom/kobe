import { describe, expect, it } from "vitest";
import {
  UPLOAD_DEFAULT_MAX_FILE_BYTES,
  UPLOAD_DEFAULT_MAX_MESSAGE_BYTES,
  UPLOAD_ERROR_CODES,
  UPLOAD_ERROR_HTTP_STATUS,
  UPLOAD_MAX_FILES_PER_MESSAGE,
  decodeServerFrame,
  submitMessageBodySchema,
  uploadErrorSchema,
  uploadFieldsSchema,
  uploadFileNameSchema,
  uploadResponseSchema,
  UPLOAD_ATTACHMENT_ROOT,
  sandboxAttachmentSchema,
} from "./index.js";
import { EXAMPLE_IDS } from "./testing/index.js";

const MIB = 1024 * 1024;

describe("limits", () => {
  it("defaults are 100 MiB per file and 500 MiB per message (D26)", () => {
    expect(UPLOAD_DEFAULT_MAX_FILE_BYTES).toBe(100 * MIB);
    expect(UPLOAD_DEFAULT_MAX_MESSAGE_BYTES).toBe(500 * MIB);
    expect(UPLOAD_MAX_FILES_PER_MESSAGE).toBe(100);
  });
});

describe("error codes", () => {
  it("lists the five codes with an HTTP status each", () => {
    expect([...UPLOAD_ERROR_CODES]).toEqual([
      "file_too_large",
      "message_too_large",
      "quota_exceeded",
      "scan_rejected",
      "scan_unavailable",
    ]);
    for (const code of UPLOAD_ERROR_CODES) {
      expect(UPLOAD_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });
  it("decodes an error body and rejects an unknown code", () => {
    const ok = { code: "file_too_large", message: "too big", limit_bytes: 100 * MIB };
    expect(uploadErrorSchema.parse(ok)).toEqual(ok);
    expect(uploadErrorSchema.safeParse({ code: "file_too_large", message: "m" }).success).toBe(
      true,
    );
    expect(uploadErrorSchema.safeParse({ code: "nope", message: "m" }).success).toBe(false);
  });
});

describe("POST /v1/uploads", () => {
  it("validates file names", () => {
    expect(uploadFileNameSchema.safeParse("sales 2026.csv").success).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\u0000b", "a\nb", "x".repeat(256)]) {
      expect(uploadFileNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("fields: thread_id optional, strict", () => {
    expect(uploadFieldsSchema.safeParse({}).success).toBe(true);
    expect(uploadFieldsSchema.safeParse({ thread_id: EXAMPLE_IDS.thread }).success).toBe(true);
    expect(uploadFieldsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
  it("response", () => {
    const body = {
      file_id: EXAMPLE_IDS.file,
      name: "sales.csv",
      mime_type: "text/csv",
      size_bytes: 12,
      scan: "skipped",
      created_at: "2026-10-09T10:00:00Z",
    };
    expect(uploadResponseSchema.parse(body)).toEqual(body);
    expect(uploadResponseSchema.safeParse({ ...body, size_bytes: -1 }).success).toBe(false);
    expect(uploadResponseSchema.safeParse({ ...body, scan: "pending" }).success).toBe(false);
  });
});

describe("file_ids on message submit", () => {
  it("old bodies decode; ids must be unique and at most the per-message count", () => {
    expect(submitMessageBodySchema.safeParse({ content: "hi" }).success).toBe(true);
    const id = EXAMPLE_IDS.file;
    expect(submitMessageBodySchema.safeParse({ content: "hi", file_ids: [id] }).success).toBe(true);
    expect(submitMessageBodySchema.safeParse({ content: "hi", file_ids: [id, id] }).success).toBe(
      false,
    );
    const many = Array.from(
      { length: UPLOAD_MAX_FILES_PER_MESSAGE + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(submitMessageBodySchema.safeParse({ content: "hi", file_ids: many }).success).toBe(
      false,
    );
  });
});

describe("run.start attachments", () => {
  const base = {
    v: 1,
    type: "run.start",
    command_id: "c1",
    run_id: EXAMPLE_IDS.run,
    thread_id: EXAMPLE_IDS.thread,
    message: "hi",
  };
  const path = `${UPLOAD_ATTACHMENT_ROOT}/th1/sales.csv`;
  it("decodes the old shape (path, mime_type) and the full shape", () => {
    for (const attachments of [
      [{ path, mime_type: "text/csv" }],
      [{ path, name: "sales.csv", mime_type: "image/png", size_bytes: 5, native_media: "image" }],
    ]) {
      expect(decodeServerFrame(JSON.stringify({ ...base, attachments }))).toMatchObject({
        ok: true,
      });
    }
  });
  it("rejects traversal and bad hints", () => {
    for (const bad of [
      { path: `${UPLOAD_ATTACHMENT_ROOT}/../x`, mime_type: "a/b" },
      { path, mime_type: "a/b", native_media: "video" },
      { path, mime_type: "a/b", extra: 1 },
    ]) {
      expect(sandboxAttachmentSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
