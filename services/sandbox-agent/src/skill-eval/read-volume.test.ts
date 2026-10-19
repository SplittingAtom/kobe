import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readOutputs } from "./read.js";

// Another device than any real file's: every file reads as off the workspace volume.
vi.mock("../workspace/volume.js", () => ({ volumeDevice: async () => -1 }));

let ws = "";
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("readOutputs off the workspace volume (KOBE-326 review L1)", () => {
  it("refuses a file whose device is not the workspace volume's", async () => {
    ws = await mkdtemp(path.join(tmpdir(), "kobe-eval-vol-"));
    await mkdir(path.join(ws, "outputs"));
    await writeFile(path.join(ws, "outputs/a.txt"), "abc");
    const out = await readOutputs(ws, {
      v: 1,
      type: "eval.read",
      command_id: "c1",
      thread_id: "11111111-1111-4111-8111-111111111111",
      files: [{ path: "outputs/a.txt", size: 3 }],
    });
    expect(out.files).toEqual([{ path: "outputs/a.txt", status: "refused", reason: "off_volume" }]);
  });
});
