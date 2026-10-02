import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkPolicyExtensionFile } from "./extension-file.js";

describe("checkPolicyExtensionFile", () => {
  it("accepts a root-owned file in root-owned, non-writable directories", async () => {
    // A file every test host has, owned by root along its whole path.
    await expect(checkPolicyExtensionFile("/bin/sh")).resolves.toBeUndefined();
  });

  it("refuses a missing file", async () => {
    await expect(checkPolicyExtensionFile("/nonexistent/kobe-policy/index.js")).rejects.toThrow(
      /not found/,
    );
  });

  it("refuses a directory", async () => {
    await expect(checkPolicyExtensionFile("/bin")).rejects.toThrow(/not a file/);
  });

  it.skipIf(process.getuid?.() === 0)("refuses a file the sandbox user owns", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kp-file-"));
    const file = path.join(dir, "index.js");
    await writeFile(file, "export default () => {}\n", { mode: 0o444 });
    await expect(checkPolicyExtensionFile(file)).rejects.toThrow(/root-owned and read-only/);
  });
});
