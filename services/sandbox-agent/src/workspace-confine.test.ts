import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confineFile, ConfineError } from "./workspace-confine.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "confine-"));
  await mkdir(path.join(root, "d"));
  await writeFile(path.join(root, "d", "f.txt"), "hello");
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function code(rel: string, allowMissing: boolean): Promise<string> {
  try {
    await confineFile(root, rel, { allowMissing });
    return "ok";
  } catch (error) {
    return error instanceof ConfineError ? error.code : "other";
  }
}

describe("confineFile", () => {
  it("accepts a regular file and reports its size", async () => {
    expect(await confineFile(root, "d/f.txt", { allowMissing: false })).toMatchObject({
      exists: true,
      size: 5,
    });
  });

  it("a missing file is not_found, or allowed when it may not be synced yet", async () => {
    expect(await code("d/none", false)).toBe("not_found");
    expect(await confineFile(root, "d/none", { allowMissing: true })).toMatchObject({
      exists: false,
    });
  });

  it("refuses symlinks (file, dangling, directory) and directories", async () => {
    await symlink(path.join(root, "d", "f.txt"), path.join(root, "link"));
    await symlink(path.join(root, "gone"), path.join(root, "dangling"));
    await symlink(path.join(root, "d"), path.join(root, "dirlink"));
    for (const rel of ["link", "dangling", "dirlink/f.txt", "dirlink/new", "d"]) {
      expect(await code(rel, true), rel).toBe("invalid_path");
    }
  });
});
