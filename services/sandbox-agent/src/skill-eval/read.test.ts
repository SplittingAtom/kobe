import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EVAL_OUTPUT_READ_MAX_BYTES, EVAL_READ_MAX_TOTAL_BYTES } from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOutputs } from "./read.js";

let ws = "";
beforeEach(async () => {
  ws = await mkdtemp(path.join(tmpdir(), "kobe-eval-read-"));
  await mkdir(path.join(ws, "outputs"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

const frame = (files: { path: string; size: number }[]) => ({
  v: 1 as const,
  type: "eval.read" as const,
  command_id: "c1",
  thread_id: "11111111-1111-4111-8111-111111111111",
  files,
});
const decoded = (data: string) => Buffer.from(data, "base64").toString("utf8");

describe("readOutputs (KOBE-326)", () => {
  it("reads a regular file of the walked size", async () => {
    await writeFile(path.join(ws, "outputs/report.txt"), "Total: 42");
    const out = await readOutputs(ws, frame([{ path: "outputs/report.txt", size: 9 }]));
    expect(out.files).toEqual([
      { path: "outputs/report.txt", status: "read", data: expect.any(String), truncated: false },
    ]);
    const first = out.files[0];
    expect(first?.status === "read" && decoded(first.data)).toBe("Total: 42");
  });

  it("refuses symlinks: the file itself, and a parent on the way", async () => {
    await symlink("/etc/passwd", path.join(ws, "outputs/link.txt"));
    await mkdir(path.join(ws, "a"));
    await symlink("/etc", path.join(ws, "a/b"));
    const out = await readOutputs(
      ws,
      frame([
        { path: "outputs/link.txt", size: 11 },
        { path: "a/b/passwd", size: 1 },
      ]),
    );
    expect(out.files).toEqual([
      { path: "outputs/link.txt", status: "refused", reason: "link" },
      { path: "a/b/passwd", status: "refused", reason: "link" },
    ]);
  });

  it("refuses a hard link: the output and its other name share an inode (review L1)", async () => {
    await writeFile(path.join(ws, "agent-temp"), "secret!");
    await link(path.join(ws, "agent-temp"), path.join(ws, "outputs/copy.txt"));
    const out = await readOutputs(ws, frame([{ path: "outputs/copy.txt", size: 7 }]));
    expect(out.files).toEqual([{ path: "outputs/copy.txt", status: "refused", reason: "link" }]);
  });

  it("refuses non-regular files (a FIFO never blocks, a directory) and a changed size", async () => {
    execFileSync("mkfifo", [path.join(ws, "outputs/pipe")]);
    await mkdir(path.join(ws, "outputs/dir"));
    await writeFile(path.join(ws, "outputs/grew.txt"), "longer than walked");
    const out = await readOutputs(
      ws,
      frame([
        { path: "outputs/pipe", size: 0 },
        { path: "outputs/dir", size: 64 },
        { path: "outputs/grew.txt", size: 3 },
      ]),
    );
    expect(out.files).toEqual([
      { path: "outputs/pipe", status: "refused", reason: "not_regular" },
      { path: "outputs/dir", status: "refused", reason: "not_regular" },
      { path: "outputs/grew.txt", status: "refused", reason: "size_changed" },
    ]);
  });

  it("reads at most the per-file cap of an oversize file, and stops at the total", async () => {
    const big = EVAL_OUTPUT_READ_MAX_BYTES + 1000;
    const files = Array.from({ length: 6 }, (_, i) => ({ path: `outputs/f${i}.txt`, size: big }));
    for (const f of files) await writeFile(path.join(ws, f.path), "x".repeat(big));
    const out = await readOutputs(ws, frame(files));
    const read = out.files.filter((f) => f.status === "read");
    expect(read).toHaveLength(EVAL_READ_MAX_TOTAL_BYTES / EVAL_OUTPUT_READ_MAX_BYTES);
    for (const f of read) {
      expect(f.truncated).toBe(true);
      expect(Buffer.from(f.data, "base64").length).toBe(EVAL_OUTPUT_READ_MAX_BYTES);
    }
    expect(out.files.slice(read.length).map((f) => f.status)).toEqual(["skipped", "skipped"]);
  });

  it("refuses a missing file and a reserved path", async () => {
    await mkdir(path.join(ws, ".kobe"));
    await writeFile(path.join(ws, ".kobe/session.jsonl"), "secret");
    const out = await readOutputs(
      ws,
      frame([
        { path: "outputs/none.txt", size: 1 },
        { path: ".kobe/session.jsonl", size: 6 },
      ]),
    );
    expect(out.files).toEqual([
      { path: "outputs/none.txt", status: "refused", reason: "unreadable" },
      { path: ".kobe/session.jsonl", status: "refused", reason: "unreadable" },
    ]);
  });
});
