import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FILE_SHARE_MAX_BYTES } from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSharePath, SharePathError } from "./share-path.js";

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "kobe-share-")));
  root = path.join(base, "workspace");
  outside = path.join(base, "outside");
  await mkdir(path.join(root, "out"), { recursive: true });
  await mkdir(path.join(root, ".kobe"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(root, "out", "report.csv"), "a,b\n1,2\n");
  await writeFile(path.join(root, ".kobe", "secret"), "x");
  await writeFile(path.join(outside, "secret.txt"), "top secret");
});
afterEach(() => rm(base, { recursive: true, force: true }));

async function codeOf(input: string): Promise<string> {
  try {
    await resolveSharePath(root, input);
  } catch (error) {
    if (error instanceof SharePathError) return error.code;
    throw error;
  }
  return "resolved";
}

describe("resolveSharePath", () => {
  it("accepts a relative and an absolute path inside the workspace", async () => {
    for (const input of ["out/report.csv", "./out/report.csv", `${root}/out/report.csv`]) {
      expect(await resolveSharePath(root, input)).toEqual({ rel: "out/report.csv", size: 8 });
    }
  });

  it.each([
    ["traversal", "../outside/secret.txt"],
    ["traversal in the middle", "out/../../outside/secret.txt"],
    ["absolute outside", "/etc/passwd"],
    ["a sibling with the root as prefix", "PLACEHOLDER"],
    ["the root itself", "."],
    ["empty", ""],
    ["a control character", "out/re\u0000port.csv"],
    ["a backslash", "out\\report.csv"],
  ])("refuses %s", async (_name, input) => {
    const value = input === "PLACEHOLDER" ? `${root}-evil/x` : input;
    expect(await codeOf(value)).toBe("invalid_path");
  });

  it("refuses the excluded .kobe area", async () => {
    expect(await codeOf(".kobe/secret")).toBe("invalid_path");
  });

  it("refuses a symlink to a file outside the workspace", async () => {
    await symlink(path.join(outside, "secret.txt"), path.join(root, "out", "link.txt"));
    expect(await codeOf("out/link.txt")).toBe("invalid_path");
  });

  it("refuses a dangling symlink as a symlink", async () => {
    await symlink(path.join(outside, "gone"), path.join(root, "dangling"));
    expect(await codeOf("dangling")).toBe("invalid_path");
  });

  it("refuses a symlinked directory that leads outside", async () => {
    await symlink(outside, path.join(root, "out", "dir"));
    expect(await codeOf("out/dir/secret.txt")).toBe("invalid_path");
  });

  it("refuses a symlink that stays inside the workspace (no indirection at all)", async () => {
    await symlink(path.join(root, "out", "report.csv"), path.join(root, "alias.csv"));
    expect(await codeOf("alias.csv")).toBe("invalid_path");
  });

  it("refuses a workspace root reached through a symlinked component of the input", async () => {
    await symlink(root, path.join(base, "ws-link"));
    expect(await codeOf(`${base}/ws-link/out/report.csv`)).toBe("invalid_path");
  });

  it("refuses a directory and a missing file", async () => {
    expect(await codeOf("out")).toBe("invalid_path");
    expect(await codeOf("out/nope.csv")).toBe("not_found");
    expect(await codeOf("nope/nope.csv")).toBe("not_found");
  });

  it("refuses a FIFO", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    expect(await codeOf("pipe")).toBe("invalid_path");
  });

  it("refuses a file over the share limit without reading it", async () => {
    const big = path.join(root, "big.bin");
    await writeFile(big, "");
    await truncate(big, FILE_SHARE_MAX_BYTES + 1);
    expect(await codeOf("big.bin")).toBe("too_large");
    await truncate(big, FILE_SHARE_MAX_BYTES);
    expect(await resolveSharePath(root, "big.bin")).toEqual({
      rel: "big.bin",
      size: FILE_SHARE_MAX_BYTES,
    });
  });

  it("accepts a hard link inside the workspace (same volume, same tree)", async () => {
    await link(path.join(root, "out", "report.csv"), path.join(root, "copy.csv"));
    expect(await codeOf("copy.csv")).toBe("resolved");
  });
});
