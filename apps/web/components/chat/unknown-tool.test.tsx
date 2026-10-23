// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuildWatcher, setActiveWatcher } from "../../lib/build/build-watcher";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { openApp } from "./testing";

/**
 * KOBE-487 ac-3: a tool this client doesn't know (the web was redeployed with it) still renders
 * as the generic tool card, and makes the page ask whether a newer build is served.
 */
let fake: FakeKobe;

afterEach(() => {
  cleanup();
  setActiveWatcher(undefined);
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

function thread(tool: string) {
  const t = fake.addThread("Tools");
  const u = fake.addEntry(t, null, { role: "user", content: "Do it" });
  const a = fake.addEntry(t, u, {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: tool, arguments: { path: "/a.md" } }],
  });
  fake.addEntry(t, a, {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: tool,
    content: [{ type: "text", text: "ok" }],
    isError: false,
  });
  return t;
}

function watch() {
  const watcher = createBuildWatcher({ current: "a", fetchBuildId: async () => "a", now: () => 0 });
  const check = vi.spyOn(watcher, "check");
  setActiveWatcher(watcher);
  return check;
}

describe("a tool this client doesn't know (KOBE-487 ac-3)", () => {
  it("renders the generic tool card and checks for a newer build", async () => {
    const check = watch();
    openApp(fake, thread("brand_new_tool"));
    const card = await screen.findByRole("region", { name: "Tool call brand_new_tool" });
    expect(must(card.querySelector("[data-kobe-tool-badge]")).textContent).toBe("brand_new_tool");
    expect(within(card).getAllByText(/brand_new_tool/).length).toBeGreaterThan(0);
    await waitFor(() => expect(check).toHaveBeenCalledWith("unknown-input"));
  });

  it("does not check for a tool it knows", async () => {
    const check = watch();
    openApp(fake, thread("read"));
    await screen.findByRole("region", { name: "Tool call read" });
    expect(check).not.toHaveBeenCalled();
  });
});
