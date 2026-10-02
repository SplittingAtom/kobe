import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXAMPLE_IDS } from "@kobe/protocol/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BRANCH_CUSTOM_TYPE,
  SessionRestore,
  appendBranchMarker,
  readEntryIds,
  sessionFilePath,
} from "./session-files.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kobe-sessions-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const header = {
  type: "session" as const,
  version: 3 as const,
  id: "s",
  timestamp: "t",
  cwd: "/workspace",
};
const entry = (id: string, parentId: string | null) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-10-01T22:00:00Z",
  message: { role: "user", content: "hi" },
});
const lines = async (file: string) =>
  (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("sessionFilePath", () => {
  it("maps a thread to <dir>/<thread>.jsonl and refuses anything but a uuid", () => {
    expect(sessionFilePath("/s", EXAMPLE_IDS.thread)).toBe(`/s/${EXAMPLE_IDS.thread}.jsonl`);
    expect(() => sessionFilePath("/s", "../etc/passwd")).toThrow();
  });
});

describe("appendBranchMarker", () => {
  it("appends a custom entry (no model context) whose parent is the branch point", async () => {
    const file = path.join(dir, "t.jsonl");
    await writeFile(
      file,
      [header, entry("a1", null), entry("b1", "a1")].map((r) => JSON.stringify(r)).join("\n") +
        "\n",
    );
    const result = await appendBranchMarker(file, "a1", EXAMPLE_IDS.run, new Date(0));
    expect(result.ok).toBe(true);
    const last = (await lines(file)).at(-1);
    expect(last).toMatchObject({
      type: "custom",
      parentId: "a1",
      customType: BRANCH_CUSTOM_TYPE,
      data: { run_id: EXAMPLE_IDS.run },
      timestamp: "1970-01-01T00:00:00.000Z",
    });
    expect(result.ok && last?.id === result.entryId).toBe(true);
    expect([...(await readEntryIds(file))]).toHaveLength(3);
  });

  it("never appends through a symlinked session file", async () => {
    const victim = path.join(dir, "victim.txt");
    await writeFile(victim, `${JSON.stringify(header)}\n${JSON.stringify(entry("a1", null))}\n`);
    const file = path.join(dir, "t.jsonl");
    await symlink(victim, file);
    await expect(appendBranchMarker(file, "a1", EXAMPLE_IDS.run)).rejects.toThrow();
    expect((await readFile(victim, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("refuses an unknown parent or a missing file", async () => {
    const file = path.join(dir, "t.jsonl");
    expect(await appendBranchMarker(file, "a1", EXAMPLE_IDS.run)).toEqual({
      ok: false,
      message: "thread has no session file",
    });
    await writeFile(file, `${JSON.stringify(header)}\n${JSON.stringify(entry("a1", null))}\n`);
    expect(await appendBranchMarker(file, "zz", EXAMPLE_IDS.run)).toMatchObject({ ok: false });
  });
});

describe("SessionRestore", () => {
  it("writes parts to a temp file and renames into place only on commit", async () => {
    const target = path.join(dir, "t.jsonl");
    const restore = new SessionRestore(target, 1_000_000);
    await restore.writePart(0, header, [entry("a1", null)], () => header);
    await expect(stat(target)).rejects.toThrow();
    await restore.writePart(1, undefined, [entry("b1", "a1")], () => header);
    expect(await restore.commit()).toBe(2);
    expect((await lines(target)).map((r) => r.id)).toEqual(["s", "a1", "b1"]);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("uses an unpredictable temp name that a planted symlink cannot redirect", async () => {
    const target = path.join(dir, "t.jsonl");
    const victim = path.join(dir, "victim.txt");
    await writeFile(victim, "keep");
    await symlink(victim, `${target}.restore.tmp`); // the old, predictable name
    const restore = new SessionRestore(target, 1_000_000);
    await restore.writePart(0, header, [], () => header);
    await restore.commit();
    expect(await readFile(victim, "utf8")).toBe("keep");
    expect((await lines(target))[0]).toMatchObject({ type: "session" });
  });

  it("uses the fallback header when part 0 has none", async () => {
    const target = path.join(dir, "t.jsonl");
    const restore = new SessionRestore(target, 1_000_000);
    await restore.writePart(0, undefined, [], () => ({ ...header, id: "fallback" }));
    await restore.commit();
    expect((await lines(target))[0]).toMatchObject({ type: "session", id: "fallback" });
  });

  it("rejects out-of-order parts, a late header and oversize sessions", async () => {
    const target = path.join(dir, "t.jsonl");
    const restore = new SessionRestore(target, 300);
    await expect(restore.writePart(1, undefined, [], () => header)).rejects.toThrow(
      /expected part 0/,
    );
    await restore.writePart(0, header, [], () => header);
    await expect(restore.writePart(1, header, [], () => header)).rejects.toThrow(/header/);
    const big = Array.from({ length: 5 }, (_, i) => entry(`e${i}`, null));
    await expect(restore.writePart(1, undefined, big, () => header)).rejects.toThrow(/too large/);
    await restore.abort();
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
