import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withItemReferences, withSkillRequest } from "@kobe/protocol";
import { RunFixture } from "./testing/run-fixture.js";

/**
 * KOBE-490 ac-3: items an MCP App put in the composer as chips go with the member's message as
 * `references`; the server appends one fixed line naming them after the member's text, which is
 * what Pi gets and what the user entry (history, reload) keeps. A queued message keeps its line
 * when its text is edited. The field is bounded; an empty list or a bad name is refused.
 */
const f = new RunFixture();
beforeAll(() => f.setup());
afterAll(() => f.teardown());

const refs = [
  { name: "cat.ns.orders", kind: "table" },
  { name: "cat.ns.recent", kind: "view" },
];

describe("item references on a message (KOBE-490)", () => {
  it("reach Pi as the server's line after the member's text", async () => {
    const w = await f.world();
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const res = await f.send(w.owner, threadId, "Compare these", 0, { references: refs });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const runId = res.json.run_id as string;
    const expected = withItemReferences(refs, "Compare these");
    expect(expected).toBe(
      "Compare these\n\nReferenced: `cat.ns.orders` (table), `cat.ns.recent` (view)",
    );
    expect((await f.run(w.team, runId)).input).toBe(expected);
    const frame = await ws.started(runId);
    expect(frame.message).toBe(expected);
    ws.reply(frame, "done");
    await f.until(w.team, runId, "completed");
    // The thread's title is the member's own text.
    const thread = await w.owner.browser.get(`/v1/threads/${threadId}`);
    expect(JSON.stringify(thread.json)).not.toMatch(/"title":"[^"]*Referenced/);
  });

  it("refuses an empty list, a bad name or duplicates", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    for (const references of [
      [],
      [{ name: "a`b", kind: "table" }],
      [{ name: "a", kind: "Table" }],
      [refs[0], refs[0]],
    ]) {
      const res = await f.send(w.owner, threadId, "x", 0, { references });
      expect(res.status, JSON.stringify(references)).toBe(400);
    }
  });

  it("keeps a queued message's references (and skill line) when its text is edited", async () => {
    const w = await f.world();
    await f.connect(w);
    const threadId = await f.thread(w.owner);
    expect((await f.send(w.owner, threadId, "first")).status).toBe(201);
    const queued = await f.send(w.owner, threadId, "second", 0, { references: refs });
    expect(queued.json.queued).toBe(true);
    const runId = queued.json.run_id as string;
    const edited = await w.owner.browser.patch(`/v1/runs/${runId}`, { content: "edited" });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect((await f.run(w.team, runId)).input).toBe(withItemReferences(refs, "edited"));
  });

  it("puts the references after a skill line's member text", () => {
    // The order the server writes: skill line, member text, references (no DB needed).
    expect(withSkillRequest("x", withItemReferences(refs, "q"))).toMatch(
      /^Use the skill "x"[^]*\n\nq\n\nReferenced: `cat\.ns\.orders` \(table\)/,
    );
  });
});
