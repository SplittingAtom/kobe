import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { descendantPids } from "./descendants.js";

describe("descendantPids", () => {
  it("walks the ppid tree from /proc stat files (comm may contain ') ')", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kobe-proc-"));
    const stat = async (pid: number, ppid: number, comm = "x") => {
      await mkdir(path.join(dir, String(pid)));
      await writeFile(path.join(dir, String(pid), "stat"), `${pid} (${comm}) S ${ppid} 1 1 0`);
    };
    await stat(10, 1);
    await stat(11, 10, "bash) S 99 (evil");
    await stat(12, 11);
    await stat(13, 1);
    await mkdir(path.join(dir, "self"));
    expect(descendantPids(10, dir).sort()).toEqual([11, 12]);
    expect(descendantPids(13, dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("returns nothing without /proc", () => {
    expect(descendantPids(1, "/nonexistent-proc")).toEqual([]);
  });
});
