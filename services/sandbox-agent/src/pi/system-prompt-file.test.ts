import { mkdtemp, rm, stat, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SYSTEM_PROMPT_MAX_BYTES } from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SystemPromptFile, systemPromptArgs } from "./system-prompt-file.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kobe-prompt-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SystemPromptFile (KOBE-123)", () => {
  it("writes the exact text with the exact mode and verifies it", async () => {
    const file = new SystemPromptFile(path.join(dir, "p.md"), "héllo\n", 0o640);
    await file.write();
    expect((await stat(file.path)).mode & 0o777).toBe(0o640);
    expect(await readFile(file.path, "utf8")).toBe("héllo\n");
    expect(await file.verify()).toBe(true);
  });

  it("detects a rewritten, replaced or removed file", async () => {
    const file = new SystemPromptFile(path.join(dir, "p.md"), "one");
    await file.write();
    await writeFile(file.path, "two");
    expect(await file.verify()).toBe(false);
    await rm(file.path);
    expect(await file.verify()).toBe(false);
    await writeFile(path.join(dir, "real"), "one");
    await symlink(path.join(dir, "real"), file.path);
    expect(await file.verify()).toBe(false);
  });

  it("never follows a planted link or overwrites an existing file", async () => {
    const target = path.join(dir, "victim");
    await writeFile(target, "keep");
    await symlink(target, path.join(dir, "p.md"));
    await expect(new SystemPromptFile(path.join(dir, "p.md"), "x").write()).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("keep");
  });

  it("refuses a prompt over SYSTEM_PROMPT_MAX_BYTES (UTF-8 bytes), accepts the limit", () => {
    expect(
      () => new SystemPromptFile(path.join(dir, "a"), "a".repeat(SYSTEM_PROMPT_MAX_BYTES)),
    ).not.toThrow();
    expect(
      () => new SystemPromptFile(path.join(dir, "b"), "é".repeat(SYSTEM_PROMPT_MAX_BYTES / 2 + 1)),
    ).toThrow(/exceeds/);
  });

  it("appends (never replaces) with an args array", () => {
    expect(systemPromptArgs("/r/system-prompt.md")).toEqual([
      "--append-system-prompt",
      "/r/system-prompt.md",
    ]);
  });
});
