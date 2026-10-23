// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { withItemReferences } from "@kobe/protocol";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { BRIDGE_ATTACHED_ATTR } from "./app-frame";
import { chatRequests, composer, openApp, streaming } from "../chat/testing";

/**
 * KOBE-490 ac-1..ac-4: an app's `ui/message` resource_links become removable chips (icon per
 * kind) in the composer's chip row of the card's thread, de-duplicated, instead of the text; the
 * member's send carries the chips still shown as `references`; a sent message shows its
 * references (the server's line) as chips under its text.
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

const TOOL = "mcp__catalyst__open_picker";
const TITLE = "Lakehouse Picker (app from Catalyst)";

function thread() {
  const t = fake.addThread("Picker");
  const u = fake.addEntry(t, null, { role: "user", content: "Open the picker" });
  const a = fake.addEntry(t, u, {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: TOOL, arguments: {} }],
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
      connector_id: "11111111-1111-4111-8111-111111111111",
      connector_name: "Catalyst",
      tool: "open_picker",
      app_id: "a".repeat(64),
      template_sha256: "e".repeat(64),
      view: "app",
      app: { title: "Lakehouse Picker" },
    },
  ]);
  fake.appResultBodies.set("ref-tc1", { id: "tc1" });
  return t;
}

async function appWindow() {
  const frame = await waitFor(
    () => {
      const f = must(screen.queryByTitle(TITLE));
      expect(f.hasAttribute(BRIDGE_ATTACHED_ATTR)).toBe(true);
      return f as HTMLIFrameElement;
    },
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

const link = (cat: string, ns: string, name: string, kind?: string) => ({
  type: "resource_link",
  uri: `catalyst://lakehouse/${cat}/${ns}/${name}`,
  name: `${cat}.${ns}.${name}`,
  title: `${name} in ${ns}`,
  ...(kind === undefined ? {} : { _meta: { "io.kobe/item-kind": kind } }),
});

function message(
  app: Awaited<ReturnType<typeof appWindow>>,
  id: number,
  content: readonly unknown[],
) {
  return app.send({
    jsonrpc: "2.0",
    id,
    method: "ui/message",
    params: { role: "user", content },
  });
}

const posts = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/messages"));
const chipRow = () => screen.queryByRole("list", { name: "Items sent with your next message" });

describe("app item chips (KOBE-490)", () => {
  it("shows a message's links as chips with their kind's icon, not its text; nothing is sent (ac-1, ac-2, ac-4)", async () => {
    openApp(fake, thread());
    const app = await appWindow();
    const box = (await composer()) as HTMLTextAreaElement;
    await message(app, 1, [
      { type: "text", text: "`cat.ns.orders`" },
      link("cat", "ns", "orders", "table"),
      link("cat", "ns", "recent", "view"),
      link("cat", "ns", "odd", "spaceship"),
      { ...link("cat", "ns", "bad", "table"), uri: "javascript:alert(1)" },
    ]);
    // The same item again: still one chip.
    await message(app, 2, [link("cat", "ns", "orders", "table")]);
    const row = await waitFor(() => must(chipRow()));
    expect(within(row).getAllByRole("listitem")).toHaveLength(3);
    const icons = [...row.querySelectorAll("[data-kobe-item-icon]")].map((i) =>
      i.getAttribute("data-kobe-item-icon"),
    );
    expect(icons).toEqual(["table", "view", "generic"]);
    // Table and view draw different icons.
    const svgs = [...row.querySelectorAll("svg[data-kobe-item-icon]")].map((s) => s.innerHTML);
    expect(svgs[0]).not.toBe(svgs[1]);
    expect(
      screen.getByRole("button", { name: "Table cat.ns.orders, from Lakehouse Picker; remove" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Item cat.ns.odd, from Lakehouse Picker; remove" }),
    ).toBeTruthy();
    // The hover spells out the exact name sent, not the app's own title (review MEDIUM-1).
    expect(screen.getByTitle("cat.ns.orders")).toBeTruthy();
    expect(screen.queryByTitle("orders in ns")).toBeNull();
    expect(box.value).toBe("");
    expect(document.querySelector("[data-kobe-app-insert-from]")).toBeNull();
    await waitFor(() =>
      expect(app.replies()).toContainEqual({ jsonrpc: "2.0", id: 1, result: {} }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(posts()).toEqual([]);
  });

  it("sends the chips still shown as references; a removed chip is dropped (ac-3)", async () => {
    openApp(fake, thread());
    const app = await appWindow();
    await message(app, 1, [
      link("cat", "ns", "orders", "table"),
      link("cat", "ns", "recent", "view"),
    ]);
    const user = userEvent.setup();
    const remove = await screen.findByRole("button", {
      name: "View cat.ns.recent, from Lakehouse Picker; remove",
    });
    // Keyboard: Delete on the chip's button removes it.
    remove.focus();
    fireEvent.keyDown(remove, { key: "Delete" });
    await waitFor(() => expect(within(must(chipRow())).getAllByRole("listitem")).toHaveLength(1));
    await user.type(await composer(), "How many rows?{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(must(posts()[0]).body).toEqual(
      expect.objectContaining({
        content: "How many rows?",
        references: [{ name: "cat.ns.orders", kind: "table" }],
      }),
    );
    await waitFor(() => expect(chipRow()).toBeNull());
  });

  it("a message without chips has no references", async () => {
    openApp(fake, thread());
    await appWindow();
    const user = userEvent.setup();
    await user.type(await composer(), "Plain{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(must(posts()[0]).body).not.toHaveProperty("references");
  });

  it("says so when an app sent links and nothing was usable", async () => {
    openApp(fake, thread());
    const app = await appWindow();
    await message(app, 1, [{ ...link("cat", "ns", "x", "table"), uri: "data:text/html,x" }]);
    expect(await screen.findByText("Lakehouse Picker sent items Kobe could not use.")).toBeTruthy();
    await waitFor(() =>
      expect(app.replies()).toContainEqual(
        expect.objectContaining({ id: 1, error: expect.objectContaining({ code: -32602 }) }),
      ),
    );
  });

  it("shows a sent message's references as chips under its text, also after reload (ac-3)", async () => {
    const t = fake.addThread("History");
    fake.addEntry(t, null, {
      role: "user",
      content: withItemReferences(
        [
          { name: "cat.ns.orders", kind: "table" },
          { name: "cat.ns.recent", kind: "view" },
        ],
        "Compare these",
      ),
    });
    openApp(fake, t);
    expect(await screen.findByText("Compare these")).toBeTruthy();
    const sent = screen.getByRole("list", { name: "Referenced items" });
    expect(within(sent).getByText("cat.ns.orders")).toBeTruthy();
    expect(
      [...sent.querySelectorAll("[data-kobe-item-icon]")].map((i) =>
        i.getAttribute("data-kobe-item-icon"),
      ),
    ).toEqual(["table", "view"]);
    expect(screen.queryByText(/Referenced:/)).toBeNull();
  });

  it("a queued message's editor and chip show the member's text; the edit keeps one line (review MEDIUM-2)", async () => {
    const t = thread();
    openApp(fake, t);
    const app = await appWindow();
    const user = userEvent.setup();
    const box = await composer();
    await user.type(box, "first{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    await streaming(fake, must(fake.activeRun(t)).run_id);
    await message(app, 1, [link("cat", "ns", "orders", "table")]);
    await waitFor(() => expect(chipRow()).not.toBeNull());
    await user.type(box, "second{Enter}");
    const queued = await screen.findByRole("button", { name: /^Edit queued message 1/ });
    expect(queued.textContent).toBe("second");
    const run = must([...fake.runs.values()].find((r) => r.status === "queued"));
    expect(run.input).toBe(
      withItemReferences([{ name: "cat.ns.orders", kind: "table" }], "second"),
    );
    await user.click(queued);
    const editor = screen.getByLabelText("Edit queued message 1") as HTMLTextAreaElement;
    expect(editor.value).toBe("second");
    await user.type(editor, " edited");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(chatRequests(fake, "PATCH").at(-1)?.body).toEqual({ content: "second edited" }),
    );
    await waitFor(() =>
      expect(run.input).toBe(
        withItemReferences([{ name: "cat.ns.orders", kind: "table" }], "second edited"),
      ),
    );
  });

  it("edit-and-regenerate keeps the references as chips, not typed text (review LOW-4)", async () => {
    const t = fake.addThread("Edit");
    const refs = [
      { name: "cat.ns.orders", kind: "table" as const },
      { name: "cat.ns.recent", kind: "view" as const },
    ];
    const root = fake.addSystemEntry(t, null, "model_change", {
      provider: "kobe",
      modelId: "kimi",
    });
    const u = fake.addEntry(t, root, {
      role: "user",
      content: withItemReferences(refs, "Compare these"),
    });
    fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
    openApp(fake, t);
    await screen.findByText("done", {}, { timeout: 4_000 });
    const user = userEvent.setup();
    await user.click(must(screen.getAllByRole("button", { name: "Edit" })[0]));
    const editor = (await screen.findByLabelText("Edit your message")) as HTMLTextAreaElement;
    expect(editor.value).toBe("Compare these");
    const form = must(editor.closest("form"));
    // The edit shows the references as chips; the member removes one.
    await user.click(within(form).getByRole("button", { name: "View cat.ns.recent; remove" }));
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(must(posts()[0]).body).toEqual({
      parent_entry_id: root,
      content: "Compare these",
      references: [{ name: "cat.ns.orders", kind: "table" }],
    });
  });

  it("regenerate sends the same references again", async () => {
    const t = fake.addThread("Regenerate");
    const root = fake.addSystemEntry(t, null, "model_change", {
      provider: "kobe",
      modelId: "kimi",
    });
    const refs = [{ name: "cat.ns.orders", kind: "table" as const }];
    const u = fake.addEntry(t, root, { role: "user", content: withItemReferences(refs, "Count") });
    fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
    openApp(fake, t);
    await screen.findByText("done", {}, { timeout: 4_000 });
    await userEvent.setup().click(must(screen.getAllByRole("button", { name: "Regenerate" })[0]));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(must(posts()[0]).body).toMatchObject({ content: "Count", references: refs });
  });
});
