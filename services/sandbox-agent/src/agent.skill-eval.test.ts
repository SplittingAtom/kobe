import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillEvalHooks } from "./skill-eval/hooks.js";
import { THREAD, startHarness, type Harness } from "./testing/harness.js";

let h: Harness;
afterEach(async () => {
  expect(h.server.violations).toEqual([]);
  await h.close();
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("skill eval commands (KOBE-325)", () => {
  it("announces skill_eval, copies fixtures in and snapshots the workspace", async () => {
    let ws = "";
    h = await startHarness({
      skillEval: (dir) => {
        ws = dir;
        return createSkillEvalHooks({
          workspaceDir: dir,
          serverUrl: "ws://unused.invalid",
          readToken: async () => "t",
          fetchFixture: async () => Buffer.from("a,b"),
        });
      },
    });
    expect(h.server.frames("hello")[0]?.capabilities).toContain("skill_eval");
    const prepared = await h.server.command({
      type: "eval.prepare",
      thread_id: THREAD,
      files: [{ path: "in/sales.csv", sha256: sha("a,b"), size: 3 }],
    });
    expect(prepared).toMatchObject({ ok: true });
    expect(await readFile(path.join(ws, "in/sales.csv"), "utf8")).toBe("a,b");
    await mkdir(path.join(ws, "outputs"));
    await writeFile(path.join(ws, "outputs/r.txt"), "done");
    const snap = await h.server.command({
      type: "eval.snapshot",
      thread_id: THREAD,
      roots: ["outputs/"],
      hash_paths: ["in/sales.csv"],
    });
    expect(snap).toMatchObject({
      ok: true,
      data: {
        walks: [
          {
            root: "outputs/",
            entries: [{ path: "outputs/r.txt", type: "file", size: 4 }],
            truncated: false,
          },
        ],
      },
    });
    // KOBE-326: the matched outputs' bytes for the judge, by path and walked size only.
    const read = await h.server.command({
      type: "eval.read",
      thread_id: THREAD,
      files: [{ path: "outputs/r.txt", size: 4 }],
    });
    expect(read).toMatchObject({
      ok: true,
      data: {
        files: [
          {
            path: "outputs/r.txt",
            status: "read",
            data: Buffer.from("done").toString("base64"),
            truncated: false,
          },
        ],
      },
    });
  });

  it("refuses eval commands without the hooks", async () => {
    h = await startHarness();
    expect(h.server.frames("hello")[0]?.capabilities ?? []).not.toContain("skill_eval");
    const r = await h.server.command({
      type: "eval.snapshot",
      thread_id: THREAD,
      roots: [""],
      hash_paths: [],
    });
    expect(r).toMatchObject({ ok: false });
  });
});
