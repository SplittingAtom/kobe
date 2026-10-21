import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaySession } from "./session-replay.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const system = { role: "system", content: "", sections: { preamble: "Pi" }, timestamp: 1 };
const user = (text: string) => ({ role: "user", content: text, timestamp: 2 });
const answer = (text: string, input: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  model: "glm-5",
  usage: { input, cacheRead: 0, cacheWrite: 0, output: 1 },
  timestamp: 1_792_000_000_000,
});

async function sessionFile(entries: object[]): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), "kobe-replay-"));
  const file = path.join(dir, "s.jsonl");
  const header = { type: "session", version: 3, id: "t" };
  await writeFile(file, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n{torn");
  return file;
}

const msg = (id: string, parentId: string | null, message: object) => ({
  type: "message",
  id,
  parentId,
  message,
});

describe("session replay (KOBE-470)", () => {
  it("returns the context before the last answer, on the leaf's branch", async () => {
    const file = await sessionFile([
      msg("a", null, system),
      msg("b", "a", user("first")),
      msg("c", "b", answer("one", 100)),
      msg("d", "c", user("abandoned")),
      msg("e", "d", answer("lost", 1)),
      msg("f", "c", user("second")),
      msg("g", "f", answer("two", 250)),
      msg("h", "g", { role: "toolResult", toolName: "bash", content: "late" }),
    ]);
    const call = await replaySession(file);
    expect(call?.answer).toMatchObject({ usage: { input: 250 } });
    expect(call?.messages.map((m) => (m as { role: string }).role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect((call?.messages[3] as { content: string }).content).toBe("second");
  });

  it("honours the latest compaction before the answer", async () => {
    const file = await sessionFile([
      msg("a", null, system),
      msg("b", "a", user("old")),
      msg("c", "b", answer("old answer", 10)),
      msg("d", "c", user("kept")),
      {
        type: "compaction",
        id: "e",
        parentId: "d",
        summary: "S",
        firstKeptEntryId: "d",
        systemMessage: { role: "system", content: "", sections: { preamble: "checkpoint" } },
      },
      msg("f", "e", user("new")),
      msg("g", "f", answer("new answer", 40)),
    ]);
    const call = await replaySession(file);
    expect(call?.messages).toEqual([
      { role: "system", content: "", sections: { preamble: "checkpoint" } },
      { role: "compactionSummary", summary: "S" },
      user("kept"),
      user("new"),
    ]);
  });

  it("reads only the file's tail and says when the call's history began before it", async () => {
    const old = Array.from({ length: 50 }, (_, i) =>
      msg(`o${i}`, i === 0 ? null : `o${i - 1}`, user(`old ${"x".repeat(200)} ${i}`)),
    );
    const file = await sessionFile([
      ...old,
      msg("q", "o49", user("question")),
      msg("r", "q", answer("reply", 77)),
    ]);
    const call = await replaySession(file, 2_000);
    expect(call?.historyCut).toBe(true);
    expect(call?.answer).toMatchObject({ usage: { input: 77 } });
    expect(call?.messages.length).toBeLessThan(10);
    expect((call?.messages.at(-1) as { content: string }).content).toBe("question");
    // Read whole, nothing is cut.
    expect((await replaySession(file))?.historyCut).toBeUndefined();
  });

  it("needs no older history when a compaction inside the tail replaced it", async () => {
    const old = Array.from({ length: 50 }, (_, i) =>
      msg(`o${i}`, i === 0 ? null : `o${i - 1}`, user(`old ${"x".repeat(200)} ${i}`)),
    );
    const file = await sessionFile([
      ...old,
      msg("k", "o49", user("kept")),
      { type: "compaction", id: "c", parentId: "k", summary: "S", firstKeptEntryId: "k" },
      msg("q", "c", user("question")),
      msg("r", "q", answer("reply", 77)),
    ]);
    const call = await replaySession(file, 1_000);
    expect(call?.historyCut).toBe(false);
    expect(call?.messages).toEqual([
      { role: "compactionSummary", summary: "S" },
      user("kept"),
      user("question"),
    ]);
  });

  it("has no call before any answer, and no session without a regular file", async () => {
    const file = await sessionFile([msg("a", null, system), msg("b", "a", user("hi"))]);
    expect((await replaySession(file))?.answer).toBeNull();
    const link = path.join(dir as string, "link.jsonl");
    await symlink(file, link);
    expect(await replaySession(link)).toBeUndefined();
    expect(await replaySession(path.join(dir as string, "missing.jsonl"))).toBeUndefined();
  });
});
