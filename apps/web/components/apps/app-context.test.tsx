// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { APP_CONTEXT_PREAMBLE } from "@kobe/protocol";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { chatRequests, composer, openApp } from "../chat/testing";

/**
 * KOBE-439 (MA-7) ac-1, ac-2, ac-3: an app's `ui/message` goes into the composer of its own
 * thread and is never sent; its `ui/update-model-context` is a visible, removable chip; only the
 * chips shown go with the member's send; a sent context shows in history as a chip.
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
const CONNECTOR = "11111111-1111-4111-8111-111111111111";
const TOOL = "mcp__catalyst__open_explorer";

function thread() {
  const t = fake.addThread("Explorer");
  const u = fake.addEntry(t, null, { role: "user", content: "Open the explorer" });
  const a = fake.addEntry(t, u, {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: TOOL, arguments: { q: "x" } }],
  });
  const r = fake.addEntry(t, a, {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: TOOL,
    content: [{ type: "text", text: "tree" }],
    isError: false,
  });
  fake.addEntry(t, r, { role: "assistant", content: [{ type: "text", text: "Here." }] });
  fake.appResults.set(t, [
    {
      result_ref: "ref-tc1",
      run_id: "run-1",
      user_entry_id: u,
      tool_call_id: "tc1",
      entry_id: null,
      connector_id: CONNECTOR,
      connector_name: "Catalyst",
      tool: "open_explorer",
      app_id: APP_ID,
      template_sha256: SHA,
      view: "app",
      app: { title: "Lakehouse Explorer" },
    },
  ]);
  fake.appResultBodies.set("ref-tc1", { id: "tc1" });
  return t;
}

/** The card's frame, with a stand-in window to talk as the app. */
async function appWindow() {
  const frame = await waitFor(
    () => must(screen.queryByTitle("Lakehouse Explorer (app from Catalyst)")) as HTMLIFrameElement,
    { timeout: 4_000 },
  );
  const child = { postMessage: vi.fn() } as unknown as Window;
  Object.defineProperty(frame, "contentWindow", { value: child, configurable: true });
  const send = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source: child, origin: "null" }));
    });
  const replies = () =>
    (child.postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as unknown);
  return { send, replies };
}

const posts = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/messages"));

describe("ui/message and model context (KOBE-439)", () => {
  it("puts ui/message text into this thread's composer without moving the focus; an Enter in the app sends nothing (ac-1, MEDIUM-2)", async () => {
    openApp(fake, thread());
    const app = await appWindow();
    const frame = screen.getByTitle("Lakehouse Explorer (app from Catalyst)");
    // Let the chat finish opening (it may focus its composer once) before the app has the focus.
    await composer();
    await act(() => new Promise((r) => setTimeout(r, 300)));
    frame.focus();
    expect(document.activeElement).toBe(frame);
    const focused = document.activeElement;
    await app.send({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "Use table `c.n.t`" }] },
    });
    const box = (await composer()) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("Use table `c.n.t`"));
    await waitFor(() =>
      expect(app.replies()).toContainEqual({ jsonrpc: "2.0", id: 1, result: {} }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).toBe(focused);
    expect(document.activeElement).not.toBe(box);
    await waitFor(() =>
      expect(document.querySelector("[data-kobe-app-insert-from]")?.textContent).toContain(
        "From Lakehouse Explorer",
      ),
    );
    // The member presses Enter where the focus is: the app's frame. Nothing is sent.
    fireEvent.keyDown(focused ?? document.body, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 50));
    expect(posts()).toEqual([]);
  });

  it("does not send inserted text on Enter until the member edits or confirms it (MEDIUM-2)", async () => {
    openApp(fake, thread());
    const app = await appWindow();
    const user = userEvent.setup();
    const box = (await composer()) as HTMLTextAreaElement;
    await user.click(box);
    await user.type(box, "Look at ");
    await app.send({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "table t" }] },
    });
    await waitFor(() => expect(box.value).toBe("Look at table t"));
    expect(document.querySelector("[data-kobe-app-insert-from]")?.textContent).toContain(
      "From Lakehouse Explorer",
    );
    await user.keyboard("{Enter}");
    await new Promise((r) => setTimeout(r, 50));
    expect(posts()).toEqual([]);
    // The member edits: the marker goes, and their Enter sends.
    await user.type(box, "!");
    await waitFor(() => expect(document.querySelector("[data-kobe-app-insert-from]")).toBeNull());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(must(posts()[0]).body).toMatchObject({ content: "Look at table t!" });
  });

  it("shows a removable chip and sends exactly the chips shown (ac-2)", async () => {
    const t = thread();
    openApp(fake, t);
    const app = await appWindow();
    const context = (id: number, table: string) =>
      app.send({
        jsonrpc: "2.0",
        id,
        method: "ui/update-model-context",
        params: { structuredContent: { table } },
      });
    await context(1, "c.n.old");
    await context(2, "c.n.t");
    // Last write wins per app: one chip.
    const chips = await screen.findAllByText(/^Context from Lakehouse Explorer:/);
    expect(chips).toHaveLength(1);
    expect(must(chips[0]).textContent).toContain("c.n.t");

    const user = userEvent.setup();
    await user.type(await composer(), "What is in it?{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(must(posts()[0]).body).toMatchObject({
      content: "What is in it?",
      app_context: [
        {
          connector_id: CONNECTOR,
          app_id: APP_ID,
          template_sha256: SHA,
          data: { structuredContent: { table: "c.n.t" } },
        },
      ],
    });
    // Sent: the chip is gone.
    await waitFor(() => expect(screen.queryByText(/^Context from Lakehouse Explorer:/)).toBeNull());
  });

  it("sends nothing of a chip the member removed (ac-2)", async () => {
    openApp(fake, thread());
    const app = await appWindow();
    await app.send({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/update-model-context",
      params: { structuredContent: { table: "c.n.t" } },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove context from Lakehouse Explorer" }),
    );
    const user = userEvent.setup();
    await user.type(await composer(), "Plain question{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(must(posts()[0]).body).not.toHaveProperty("app_context");
  });

  it("shows a sent context in history as a chip, not raw text (ac-3)", async () => {
    const t = fake.addThread("History");
    fake.addEntry(t, null, {
      role: "user",
      content:
        `${APP_CONTEXT_PREAMBLE}\n` +
        '<app-context source="connector:Catalyst" untrusted="true">\n{\n  "table": "c.n.t"\n}\n</app-context>\n\nWhat is in it?',
    });
    openApp(fake, t);
    expect(await screen.findByText("What is in it?")).toBeTruthy();
    expect(screen.getByText("Context from Catalyst (untrusted data)")).toBeTruthy();
    expect(screen.queryByText(new RegExp(APP_CONTEXT_PREAMBLE.slice(0, 20)))).toBeNull();
  });
});
