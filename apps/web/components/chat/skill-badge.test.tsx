// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { openApp } from "./testing";

/**
 * KOBE-297 ac-1: a skill the server saw the run use is named on the answer ("Used skill: …") and on
 * the Read step ("Read skill …"), from the thread's markers, so it is there after a reload.
 */
let fake: FakeKobe;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

const SKILL_PATH = `/run/kobe-skills/store/sk-${"a".repeat(64)}/SKILL.md`;
const read = (id: string, path: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
});
const result = (id: string, text: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
});
const say = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const ask = (content: string) => ({ role: "user", content });

function skillThread() {
  const thread = fake.addThread("Pretty page");
  const add = (parent: string | null, message: Record<string, unknown>) =>
    fake.addEntry(thread, parent, message);
  const u1 = add(null, ask("Make the report pretty"));
  const a1 = add(u1, read("tc1", SKILL_PATH));
  const r1 = add(a1, result("tc1", "# Pretty HTML"));
  const a2 = add(r1, read("tc2", "/workspace/report.md"));
  const r2 = add(a2, result("tc2", "report"));
  const a3 = add(r2, say("Here is the page."));
  // A later run reuses the call id tc1 (ids are per run): no skill there.
  const u2 = add(a3, ask("Thanks, read it again"));
  const a4 = add(u2, read("tc1", "/workspace/report.md"));
  const r4 = add(a4, result("tc1", "report"));
  add(r4, say("Done."));
  fake.threadMarkers.set(thread, {
    runs: [],
    approvals: [],
    skills: [
      {
        run_id: "run-1",
        user_entry_id: u1,
        tool_call_id: "tc1",
        name: "pretty-html",
        source: "team",
      },
    ],
  });
  return thread;
}

const cards = () => screen.getAllByRole("region", { name: /^Tool call/ });

describe("skill use badges (KOBE-297)", () => {
  it("names the skill on the answer and on its Read step, nowhere else", async () => {
    openApp(fake, skillThread());
    expect(await screen.findByText("Used skill: pretty-html")).toBeTruthy();
    await waitFor(() => expect(cards()).toHaveLength(3));
    const [skill, plain, later] = cards();
    expect(skill?.getAttribute("aria-label")).toBe("Tool call read: skill pretty-html");
    expect(within(skill as HTMLElement).getByText("Read skill")).toBeTruthy();
    expect(within(skill as HTMLElement).getByText("pretty-html")).toBeTruthy();
    expect(plain?.getAttribute("aria-label")).toBe("Tool call read");
    expect(later?.getAttribute("aria-label")).toBe("Tool call read");
    expect(screen.getAllByText(/^Used skill:/)).toHaveLength(1);
  });

  it("shows no badge without skill markers (an older server answers without the list)", async () => {
    const thread = skillThread();
    fake.threadMarkers.set(thread, { runs: [], approvals: [] });
    openApp(fake, thread);
    await screen.findByText("Here is the page.");
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(screen.queryByText(/^Used skill:/)).toBeNull();
    expect(screen.queryByText("Read skill")).toBeNull();
  });
});
