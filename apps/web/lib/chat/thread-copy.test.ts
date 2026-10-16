import { beforeEach, describe, expect, it } from "vitest";
import { createChatApi } from "./api";
import { FakeKobe } from "./testing/fake-kobe";
import { conversationMarkdown } from "./thread-copy";
import { LONG_ANSWER_LEFT_OUT, MESSAGES_LEFT_OUT } from "./thread-menu";

/** KOBE-292 review: Copy reads every page and says what it could not include. */
let fake: FakeKobe;
beforeEach(() => {
  fake = new FakeKobe();
});

const say = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const copy = (t: string) => conversationMarkdown(createChatApi(fake.teamId, fake.fetch), t, "T");

describe("conversationMarkdown", () => {
  it("reads past the first page: the whole branch is copied", async () => {
    const t = fake.addThread("T");
    let parent: string | null = null;
    for (let i = 0; i < 300; i++) {
      parent = fake.addEntry(t, parent, { role: "user", content: `q${i}` });
      parent = fake.addEntry(t, parent, say(`a${i}`));
    }
    const res = await copy(t);
    expect(res.ok && res.data.partial).toBe(false);
    const md = res.ok ? res.data.markdown : "";
    expect(md).toContain("\n\nq0\n\n");
    expect(md.endsWith("\n\na299\n")).toBe(true);
    expect(fake.requests.some((r) => r.path.includes("/entries?after="))).toBe(true);
  });

  it("ends with a placeholder when a page can't be read, and says it is partial", async () => {
    const t = fake.addThread("T");
    let parent: string | null = null;
    for (let i = 0; i < 300; i++) {
      parent = fake.addEntry(t, parent, { role: "user", content: `q${i}` });
      parent = fake.addEntry(t, parent, say(`a${i}`));
    }
    fake.failNext.set(`GET /v1/threads/${t}/entries`, new Response(null, { status: 503 }));
    const res = await copy(t);
    expect(res.ok && res.data.partial).toBe(true);
    expect(res.ok && res.data.markdown.endsWith(`\n\n${MESSAGES_LEFT_OUT}\n`)).toBe(true);
  });

  it("an offloaded answer becomes a placeholder; an offloaded tool output is left out", async () => {
    const t = fake.addThread("T");
    const u1 = fake.addEntry(t, null, { role: "user", content: "run it" });
    const a1 = fake.addEntry(t, u1, {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: {} }],
    });
    const r1 = fake.addEntry(
      t,
      a1,
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        content: [{ type: "text", text: "huge output" }],
        isError: false,
      },
      { offloaded: true },
    );
    fake.addEntry(t, r1, say("a very long answer"), { offloaded: true });
    const res = await copy(t);
    expect(res.ok && res.data).toEqual({
      markdown: `# T\n\n## You\n\nrun it\n\n## Assistant\n\n${LONG_ANSWER_LEFT_OUT}\n`,
      partial: true,
    });
  });

  it("passes on a refused thread read", async () => {
    expect((await copy("00000000-0000-4000-8000-00000000dead")).ok).toBe(false);
  });
});
