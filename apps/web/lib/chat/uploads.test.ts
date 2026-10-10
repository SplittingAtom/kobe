import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_MESSAGE_BYTES,
  formatBytes,
  precheck,
  splitAttachedFiles,
  uploadErrorMessage,
} from "./uploads";

describe("precheck", () => {
  it("accepts a file within the limits", () => {
    expect(precheck({ name: "a", size: 10 }, [])).toBeUndefined();
  });
  it("refuses a file over the per-file limit", () => {
    expect(precheck({ name: "a", size: MAX_FILE_BYTES + 1 }, [])?.code).toBe("file_too_large");
  });
  it("refuses when the message total would pass the limit", () => {
    const held = Array.from({ length: 5 }, () => ({ size: MAX_FILE_BYTES }));
    expect(precheck({ name: "a", size: 1 }, held)?.code).toBe("message_too_large");
  });
  it("refuses a 101st file", () => {
    const held = Array.from({ length: MAX_FILES }, () => ({ size: 1 }));
    expect(precheck({ name: "a", size: 1 }, held)?.code).toBe("too_many_files");
  });
  it("keeps the total limit consistent", () => {
    expect(MAX_MESSAGE_BYTES).toBeGreaterThan(MAX_FILE_BYTES);
  });
});

describe("messages and sizes", () => {
  it("names every server code in plain language, using the server's limit", () => {
    expect(uploadErrorMessage("file_too_large", 5 * 1024 * 1024)).toContain("5 MB");
    for (const code of [
      "message_too_large",
      "quota_exceeded",
      "scan_rejected",
      "scan_unavailable",
    ]) {
      expect(uploadErrorMessage(code)).toBeTruthy();
    }
    expect(uploadErrorMessage("other")).toBeUndefined();
  });
  it("formats sizes", () => {
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(100 * 1024 * 1024)).toBe("100 MB");
  });
});

describe("splitAttachedFiles", () => {
  it("separates the sandbox's attachment list from the user's text", () => {
    const text =
      "Look at these\n\nAttached files:\n- /workspace/uploads/t/report.pdf (application/pdf) - not shown inline; open it from this path\n- /workspace/uploads/t/a b.png (image/png) - shown to you as an image";
    expect(splitAttachedFiles(text)).toEqual({
      text: "Look at these",
      files: [
        {
          name: "report.pdf",
          mimeType: "application/pdf",
          path: "/workspace/uploads/t/report.pdf",
        },
        { name: "a b.png", mimeType: "image/png", path: "/workspace/uploads/t/a b.png" },
      ],
    });
  });
  it("leaves ordinary text alone", () => {
    expect(splitAttachedFiles("Attached files: none").files).toEqual([]);
    expect(splitAttachedFiles("hi").text).toBe("hi");
  });
});
