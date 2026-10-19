// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import userEvent from "@testing-library/user-event";
import { composer, openApp, streaming } from "../chat/testing";

/**
 * KOBE-438 (MA-9) ac-2, ac-3, ac-5: an MCP tool card renders its app from the stored result (a
 * reload reads Postgres, never the upstream), the text card says why when the viewer gets text,
 * at most 3 frames are live per thread ("Show app" retires the least recent), and Expand moves
 * the app into the artifact column ("Opened in the side column").
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
  // happy-dom never lays out: every card is in view.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.cb([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
      }
      disconnect() {}
      unobserve() {}
    },
  );
});

const SHA = "e".repeat(64);
const APP_ID = "a".repeat(64);
const TOOL = "mcp__catalyst__open_explorer";

function thread(calls: readonly string[]) {
  const t = fake.addThread("Explorer");
  let parent = fake.addEntry(t, null, { role: "user", content: "Open the explorer" });
  const prompt = parent;
  for (const id of calls) {
    const a = fake.addEntry(t, parent, {
      role: "assistant",
      content: [{ type: "toolCall", id, name: TOOL, arguments: { q: id } }],
    });
    parent = fake.addEntry(t, a, {
      role: "toolResult",
      toolCallId: id,
      toolName: TOOL,
      content: [{ type: "text", text: `text of ${id}` }],
      isError: false,
    });
  }
  fake.addEntry(t, parent, { role: "assistant", content: [{ type: "text", text: "Here." }] });
  return { t, prompt };
}

function view(prompt: string, id: string, extra: Record<string, unknown> = {}) {
  return {
    result_ref: `ref-${id}`,
    run_id: "run-1",
    user_entry_id: prompt,
    tool_call_id: id,
    entry_id: null,
    connector_id: "c1",
    connector_name: "Catalyst",
    tool: "open_explorer",
    app_id: APP_ID,
    template_sha256: SHA,
    view: "app",
    app: { title: "Lakehouse Explorer" },
    ...extra,
  };
}

const frames = () =>
  screen.queryAllByTitle("Lakehouse Explorer (app from Catalyst)") as HTMLIFrameElement[];

describe("apps in tool cards (KOBE-438)", () => {
  it("renders the app from the stored result, and text with its reason otherwise", async () => {
    const { t, prompt } = thread(["tc1", "tc2", "tc3"]);
    fake.appResults.set(t, [
      view(prompt, "tc1"),
      view(prompt, "tc2", { view: "text", reason: "no_access", app: undefined }),
      view(prompt, "tc3", { view: "text", reason: "template_changed", app: undefined }),
    ]);
    fake.appResultBodies.set("ref-tc1", { structuredContent: { namespaces: ["a"] } });
    openApp(fake, t);
    await waitFor(() => expect(frames()).toHaveLength(1), { timeout: 4_000 });
    const frame = must(frames()[0]);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toContain(`/v1/team/apps/${APP_ID}/frame?`);
    expect(frame.getAttribute("src")).toContain(`sha256=${SHA}`);
    expect(screen.getByText("Connect Catalyst to use this app.")).toBeTruthy();
    expect(screen.getByText("This app changed and is waiting for review.")).toBeTruthy();
    // The reload read the stored result; nothing else (no call, no upstream).
    const paths = fake.requests.map((r) => r.path.split("?")[0] ?? "");
    expect(paths).toContain(`/v1/threads/${t}/app-results/ref-tc1`);
    expect(paths.some((p) => p.endsWith("/calls"))).toBe(false);
    expect(paths).not.toContain(`/v1/threads/${t}/app-results/ref-tc2`);
  });

  it("keeps at most 3 frames live; Show app retires the least recent", async () => {
    const ids = ["tc1", "tc2", "tc3", "tc4"];
    const { t, prompt } = thread(ids);
    fake.appResults.set(
      t,
      ids.map((id) => view(prompt, id)),
    );
    for (const id of ids) fake.appResultBodies.set(`ref-${id}`, { id });
    openApp(fake, t);
    await waitFor(() => expect(frames()).toHaveLength(3), { timeout: 4_000 });
    const show = await screen.findByRole("button", { name: "Show app" });
    fireEvent.click(show);
    // One frame is torn down (after ui/resource-teardown times out) and the fourth comes up.
    await waitFor(
      () => {
        expect(frames()).toHaveLength(3);
        expect(document.querySelector('[data-kobe-app-card="ref-tc4"] iframe')).not.toBeNull();
      },
      { timeout: 4_000 },
    );
  });

  it("expands into the artifact column and says so in the card", async () => {
    const { t, prompt } = thread(["tc1"]);
    fake.appResults.set(t, [view(prompt, "tc1")]);
    fake.appResultBodies.set("ref-tc1", { id: "tc1" });
    openApp(fake, t);
    await waitFor(() => expect(frames()).toHaveLength(1), { timeout: 4_000 });
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    await screen.findByText("Opened in the side column");
    const card = must(document.querySelector('[data-kobe-app-card="ref-tc1"]')) as HTMLElement;
    await waitFor(() => expect(within(card).queryByTitle(/app from Catalyst/)).toBeNull(), {
      timeout: 4_000,
    });
    // One live frame: the column's.
    await waitFor(() => expect(frames()).toHaveLength(1), { timeout: 4_000 });
    expect(must(frames()[0]).closest("[role=tabpanel]")).not.toBeNull();
  });

  it("renders the app in the live run's card once its tool result carries the marker", async () => {
    const t = fake.addThread("Live");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "open the explorer{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const run = must(fake.activeRun(t));
    await streaming(fake, run.run_id);
    fake.agent.toolCall(run.run_id, "tc1", TOOL, { q: "x" }, "m1");
    fake.appResults.set(t, [{ ...view("", "tc1"), user_entry_id: null, run_id: run.run_id }]);
    fake.appResultBodies.set("ref-tc1", { id: "tc1" });
    fake.emit(run.run_id, "tool.result", {
      tool_call_id: "tc1",
      tool: TOOL,
      is_error: false,
      preview: "text of tc1",
      truncated: false,
      app: {
        connector_id: "11111111-1111-4111-8111-111111111111",
        app_id: APP_ID,
        template_sha256: SHA,
        result_ref: "22222222-2222-4222-8222-222222222222",
      },
    });
    await waitFor(() => expect(frames()).toHaveLength(1), { timeout: 4_000 });
  });
});
