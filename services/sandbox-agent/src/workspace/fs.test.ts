import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conflictCopyName, lockServerOwned, renameWithin, truncateUtf8 } from "./fs.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function dir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "kobe-fs-"));
  dirs.push(d);
  return d;
}

describe("workspace fs helpers", () => {
  it("keeps conflict-copy names within one path segment (255 bytes), never splitting a character", async () => {
    const root = await dir();
    const long = `${"é".repeat(120)}.markdown`; // 249 bytes
    const name = await conflictCopyName(root, `notes/${long}`, new Date("2026-10-03T12:00:00Z"));
    const segment = name.split("/").at(-1) ?? "";
    expect(Buffer.byteLength(segment)).toBeLessThanOrEqual(255);
    expect(segment).toMatch(/^é+\.conflict-20261003T120000Z\.markdown$/);
    expect(truncateUtf8("aé", 2)).toBe("a");
  });

  it("never chmods through a symlinked read-only area", async () => {
    const root = await dir();
    const outside = await dir();
    await writeFile(path.join(outside, "f"), "x", { mode: 0o644 });
    await symlink(outside, path.join(root, "uploads"));
    await lockServerOwned(root, ["uploads/"]);
    expect((await stat(path.join(outside, "f"))).mode & 0o777).toBe(0o644);
    expect((await stat(outside)).mode & 0o200).not.toBe(0);
  });

  it("refuses renames whose parents go through a link", async () => {
    const root = await dir();
    const outside = await dir();
    await mkdir(path.join(root, "a"));
    await writeFile(path.join(root, "a/f"), "x");
    await symlink(outside, path.join(root, "out"));
    await expect(renameWithin(root, "a/f", "out/f")).rejects.toThrow(/link/);
    expect((await lstat(path.join(root, "a/f"))).isFile()).toBe(true);
  });
});
