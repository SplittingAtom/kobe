import { describe, expect, it } from "vitest";
import { UPLOAD_DEFAULT_MAX_FILE_BYTES, UPLOAD_DEFAULT_MAX_MESSAGE_BYTES } from "@kobe/protocol";
import { DEFAULT_UPLOAD_SETTINGS, loadUploadSettings } from "./settings.js";

describe("upload settings", () => {
  it("defaults to the contract constants", () => {
    const s = loadUploadSettings({});
    expect(s).toEqual(DEFAULT_UPLOAD_SETTINGS);
    expect(s.maxFileBytes).toBe(UPLOAD_DEFAULT_MAX_FILE_BYTES);
    expect(s.maxMessageBytes).toBe(UPLOAD_DEFAULT_MAX_MESSAGE_BYTES);
  });

  it("reads overrides and fails fast naming the variable", () => {
    expect(loadUploadSettings({ KOBE_UPLOAD_MAX_FILE_BYTES: "2048" }).maxFileBytes).toBe(2048);
    expect(() => loadUploadSettings({ KOBE_UPLOAD_MAX_FILE_BYTES: "0" })).toThrow(
      /KOBE_UPLOAD_MAX_FILE_BYTES/,
    );
    expect(() => loadUploadSettings({ KOBE_UPLOAD_ORPHAN_HOURS: "x" })).toThrow(
      /KOBE_UPLOAD_ORPHAN_HOURS/,
    );
  });
});
