// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { OUTCOME_TONE, TOOL_BADGE } from "./tool-call";
import { openApp } from "./testing";

/**
 * KOBE-374 ac-1: the tool's name on a tool-call step is a gold chip (app/theme.css
 * `--kobe-tool-badge*`, contrast in app/theme-css.test.ts); the KOBE-301 outcome colours stay on
 * the status, and a skill's Read step keeps its "Read skill" label. happy-dom has no cascade, so
 * this pins the classes.
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

const SKILL_PATH = `/run/kobe-skills/store/sk-${"b".repeat(64)}/SKILL.md`;

function thread() {
  const t = fake.addThread("Tools");
  const add = (parent: string | null, message: Record<string, unknown>) =>
    fake.addEntry(t, parent, message);
  const call = (id: string, name: string, args: Record<string, unknown>) => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
  });
  const result = (id: string, name: string, text: string, isError = false) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError,
  });
  const u = add(null, { role: "user", content: "Look around" });
  const a1 = add(u, call("tc1", "bash", { command: "ls" }));
  const r1 = add(a1, result("tc1", "bash", "a b"));
  const a2 = add(r1, call("tc2", "read", { path: SKILL_PATH }));
  const r2 = add(a2, result("tc2", "read", "# Skill"));
  const a3 = add(r2, call("tc3", "bash", { command: "false" }));
  const r3 = add(a3, result("tc3", "bash", "exit 1", true));
  add(r3, { role: "assistant", content: [{ type: "text", text: "Done." }] });
  fake.threadMarkers.set(t, {
    runs: [],
    approvals: [],
    skills: [
      { run_id: "run-1", user_entry_id: u, tool_call_id: "tc2", name: "tidy", source: "team" },
    ],
  });
  return t;
}

const cards = () => screen.getAllByRole("region", { name: /^Tool call/ });

describe("gold tool badges (KOBE-374 ac-1)", () => {
  it("each step's tool name is a gold chip; the outcome keeps its own colour", async () => {
    openApp(fake, thread());
    await waitFor(() => expect(cards()).toHaveLength(3), { timeout: 4_000 });
    const [ls, skill, failed] = cards().map((c) => c as HTMLElement);

    const badge = must(must(ls).querySelector("[data-kobe-tool-badge]"));
    expect(badge.textContent).toBe("bash");
    for (const cls of ["bg-tool-badge-bg", "text-tool-badge", "border-tool-badge-border"]) {
      expect(badge.className).toContain(cls);
    }
    expect(TOOL_BADGE).toContain("text-tool-badge");

    // The outcome label is never gold: done stays the muted green, failed red (KOBE-301).
    const done = must(must(ls).querySelector("[data-kobe-outcome-label]"));
    expect(done.className).toMatch(/done/);
    expect(done.className).not.toContain("tool-badge");
    const error = must(must(failed).querySelector("[data-kobe-outcome-label]"));
    expect(error.getAttribute("data-kobe-outcome-label")).toBe("error");
    expect(error.className).toMatch(/failed/);
    expect(error.className).not.toContain("tool-badge");
    expect(OUTCOME_TONE).toEqual({
      denied: "failed",
      error: "failed",
      done: "done",
      waiting: "attention",
      running: "running",
    });

    // The skill's Read step keeps its label (KOBE-297), on the same chip, with the skill name.
    await waitFor(() =>
      expect(must(skill).getAttribute("aria-label")).toBe("Tool call read: skill tidy"),
    );
    const read = within(must(skill)).getByText("Read skill");
    expect(read.hasAttribute("data-kobe-tool-badge")).toBe(true);
    expect(within(must(skill)).getByText("tidy")).toBeTruthy();
  });
});
