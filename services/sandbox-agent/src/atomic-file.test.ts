import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTempOf, openAgentTemp, tempPathFor, writeFileAtomic } from "./atomic-file.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "atomic-file-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("atomic file writes (KOBE-235)", () => {
  it("writes with the exact mode despite the umask and leaves no temp file", async () => {
    const previous = process.umask(0o077);
    try {
      const file = path.join(dir, "a");
      await writeFileAtomic(file, "hello", 0o440);
      expect(await readFile(file, "utf8")).toBe("hello");
      expect((await stat(file)).mode & 0o777).toBe(0o440);
      expect(await readdir(dir)).toEqual(["a"]);
    } finally {
      process.umask(previous);
    }
  });

  it("uses a random temp name: two writes never share one, and the name matches isTempOf", () => {
    const final = path.join(dir, "mcp-token");
    const [a, b] = [tempPathFor(final), tempPathFor(final)];
    expect(a).not.toBe(b);
    expect(isTempOf("mcp-token", path.basename(a))).toBe(true);
    expect(isTempOf("mcp-token", "mcp-token.tmp")).toBe(false);
    expect(isTempOf("mcp-token", "mcp-token.x")).toBe(false);
  });

  it("refuses a FIFO at the temp path at once (no stall) and leaves it alone", async () => {
    const temp = path.join(dir, "t.tmp");
    execFileSync("mkfifo", [temp]);
    await expect(openAgentTemp(temp, 0o600)).rejects.toMatchObject({ code: "EEXIST" });
    expect((await stat(temp)).isFIFO()).toBe(true);
  });

  it("refuses a symlink at the temp path without writing through it", async () => {
    const victim = path.join(dir, "victim");
    await writeFile(victim, "keep");
    const temp = path.join(dir, "t.tmp");
    await symlink(victim, temp);
    await expect(openAgentTemp(temp, 0o600)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(victim, "utf8")).toBe("keep");
  });

  it("a FIFO planted at the final name is replaced by the rename, not opened", async () => {
    const final = path.join(dir, "mcp-token");
    execFileSync("mkfifo", [final]);
    await writeFileAtomic(final, "x", 0o400);
    expect((await stat(final)).isFile()).toBe(true);
  });
});
