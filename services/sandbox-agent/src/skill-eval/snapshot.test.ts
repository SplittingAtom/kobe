import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotWorkspace } from "./snapshot.js";

let ws = "";
beforeEach(async () => {
  ws = await mkdtemp(path.join(tmpdir(), "kobe-eval-snap-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("snapshotWorkspace (KOBE-325)", () => {
  it("walks only the roots, records regular files, hashes only fixture paths", async () => {
    await mkdir(path.join(ws, "outputs/deep"), { recursive: true });
    await writeFile(path.join(ws, "outputs/report.txt"), "out");
    await writeFile(path.join(ws, "outputs/deep/in.csv"), "fixture");
    await writeFile(path.join(ws, "elsewhere.txt"), "x");
    const snap = await snapshotWorkspace(ws, ["outputs/"], ["outputs/deep/in.csv"]);
    expect(snap.walks).toHaveLength(1);
    const walk = snap.walks[0];
    expect(walk?.truncated).toBe(false);
    expect(walk?.entries).toEqual([
      { path: "outputs/report.txt", type: "file", size: 3 },
      { path: "outputs/deep/in.csv", type: "file", size: 7, sha256: sha("fixture") },
    ]);
  });

  it("never follows a symlinked root (outputs -> /proc/self) or parent; records it instead", async () => {
    await symlink("/proc/self", path.join(ws, "outputs"));
    await mkdir(path.join(ws, "a"));
    await symlink("/etc", path.join(ws, "a/b"));
    const snap = await snapshotWorkspace(ws, ["outputs/", "a/b/c/"], []);
    expect(snap.walks[0]?.entries).toEqual([
      { path: "outputs", type: "symlink", size: expect.any(Number) },
    ]);
    expect(snap.walks[1]?.entries).toEqual([
      { path: "a/b", type: "symlink", size: expect.any(Number) },
    ]);
  });

  it("records links inside a root without reading them, and skips skills and hidden segments", async () => {
    await mkdir(path.join(ws, "outputs/skills"), { recursive: true });
    await mkdir(path.join(ws, ".kobe/sessions"), { recursive: true });
    await writeFile(path.join(ws, ".kobe/sessions/s.jsonl"), "secret");
    await writeFile(path.join(ws, "outputs/skills/x.md"), "x");
    await writeFile(path.join(ws, "outputs/.hidden"), "h");
    await symlink("/etc/passwd", path.join(ws, "outputs/link.txt"));
    const snap = await snapshotWorkspace(ws, [""], ["outputs/link.txt"]);
    expect(snap.walks[0]?.entries).toEqual([
      { path: "outputs/link.txt", type: "symlink", size: expect.any(Number) },
    ]);
  });

  it("is empty for a missing root", async () => {
    expect(await snapshotWorkspace(ws, ["nothing/"], [])).toEqual({
      walks: [{ root: "nothing/", entries: [], truncated: false }],
    });
  });
});
