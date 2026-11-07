// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ITEM_REFERENCES_MAX } from "@kobe/protocol";
import { LAKEHOUSE_DROP_REFUSED } from "../../lib/apps/lakehouse-drop";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { BRIDGE_ATTACHED_ATTR } from "../apps/app-frame";
import { LAKEHOUSE_DROP_FULL } from "./composer-mention-drop";
import { chatRequests, composer, openApp } from "./testing";

/**
 * KOBE-553 (DRAG-CONTRACT.md): a Lakehouse Picker row dragged out of the rail frame with captured
 * pointer events, told to Kobe over the bridge. Kobe draws the ghost chip at the page point,
 * lights the composer while the point is over its panel, and on release there inserts exactly
 * the click's state: the chip from the app's title, `references` on send, no text.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
  resizeWindow(DESKTOP_WIDTH);
});

afterEach(() => {
  cleanup();
  resizeWindow(DESKTOP_WIDTH);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PICKER = {
  appId: "b".repeat(64),
  connectorId: "11111111-1111-4111-8111-111111111111",
  connectorName: "Catalyst",
  iconUrl: null,
  tool: "open_b",
  title: "Lakehouse Picker",
  uri: "ui://catalyst/b",
  sha256: "e".repeat(64),
  placement: "rail",
};
const TABLE = {
  kind: "table",
  catalog: "mlb",
  namespace: "lahman",
  name: "batting",
  identifier: "mlb.lahman.batting",
  uri: "catalyst://lakehouse/mlb/lahman/batting",
};

/** The page: the picker frame at (1000, 100), the composer panel from (300, 600) to (900, 760). */
const FRAME_AT = { left: 1000, top: 100 };
const PANEL = { left: 300, top: 600, right: 900, bottom: 760 };
/** Frame-relative points: on a row, over the composer, and over the conversation. */
const ON_ROW = { x: 20, y: 30 };
const OVER_COMPOSER = { x: 600 - FRAME_AT.left, y: 680 - FRAME_AT.top };
const OVER_THREAD = { x: 600 - FRAME_AT.left, y: 300 - FRAME_AT.top };

const rect = (left: number, top: number, right: number, bottom: number): DOMRect => ({
  left,
  top,
  right,
  bottom,
  x: left,
  y: top,
  width: right - left,
  height: bottom - top,
  toJSON: () => ({}),
});

const panel = () => document.querySelector<HTMLElement>("[data-kobe-composer-panel]");
const hint = () => document.getElementById("kobe-composer-hint")?.textContent;
const ghost = () => document.querySelector<HTMLElement>("[data-kobe-frame-drag-ghost]");
const chips = () =>
  screen
    .queryByRole("list", { name: "Items sent with your next message" })
    ?.querySelectorAll("li button[aria-label]") ?? [];
const chipLabels = () => [...chips()].map((b) => b.getAttribute("aria-label"));
const posts = () =>
  chatRequests(fake, "POST")
    .filter((r) => /\/v1\/threads\/[^/]+\/messages$/.test(r.path))
    .map((r) => r.body as { content?: string; references?: unknown[] });

function thread(opts: { readOnly?: boolean; trashed?: boolean } = {}) {
  const t = fake.addThread("Tables");
  const u = fake.addEntry(t, null, { role: "user", content: "hello" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "hi" }] });
  const row = must(fake.threads.get(t));
  if (opts.readOnly) Object.assign(row, { read_only: true, owner_name: "Alice" });
  if (opts.trashed) row.deleted_at = "2026-11-01T10:00:00.000Z";
  return t;
}

/** Opens `threadId` with the picker live in the rail; the stand-in app window and its notifications. */
async function openWithPicker(threadId: string) {
  fake.teamApps = [PICKER];
  fake.preferences = { rail_picker: PICKER.appId, rail_tab: "apps" };
  openApp(fake, threadId);
  const frame = await waitFor(
    () => {
      const f = must(screen.queryByTitle("Lakehouse Picker (app from Catalyst)"));
      expect(f.hasAttribute(BRIDGE_ATTACHED_ATTR)).toBe(true);
      return f as HTMLIFrameElement;
    },
    { timeout: 4_000 },
  );
  const child = { postMessage: vi.fn() } as unknown as Window;
  Object.defineProperty(frame, "contentWindow", { value: child, configurable: true });
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(
    rect(FRAME_AT.left, FRAME_AT.top, FRAME_AT.left + 280, FRAME_AT.top + 500),
  );
  const send = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source: child, origin: "null" }));
    });
  const drag = (method: string, params: unknown) =>
    send({ jsonrpc: "2.0", method: `kobe/notifications/${method}`, params });
  return { frame, send, drag };
}

/** The composer with its panel at {@link PANEL}. */
async function placedComposer() {
  const input = await composer();
  const el = must(panel());
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(
    rect(PANEL.left, PANEL.top, PANEL.right, PANEL.bottom),
  );
  return input;
}

describe("a pointer drag from the picker frame onto the composer (KOBE-553)", () => {
  it("ghost follows, the cue shows only over the panel, the release adds the click's chip (ac-3, ac-4)", async () => {
    const user = userEvent.setup();
    const picker = await openWithPicker(thread());
    const input = await placedComposer();
    await user.type(input, "Count rows in");
    input.setSelectionRange(5, 5);
    const focused = document.activeElement;

    picker.drag("drag-start", { item: TABLE, ...ON_ROW });
    const g = must(ghost());
    expect(g.getAttribute("aria-hidden")).toBe("true");
    expect(g.style.pointerEvents).toBe("none");
    expect(g.style.position).toBe("fixed");
    expect(g.style.left).toBe("1020px");
    expect(g.style.top).toBe("130px");
    expect(g.textContent).toContain("mlb.lahman.batting");
    expect(g.querySelector('[data-kobe-item-icon="table"]')).not.toBeNull();
    expect(panel()?.hasAttribute("data-mention-drop")).toBe(false);

    picker.drag("drag-move", OVER_THREAD);
    expect(ghost()?.style.top).toBe("300px");
    expect(panel()?.hasAttribute("data-mention-drop")).toBe(false);

    picker.drag("drag-move", OVER_COMPOSER);
    expect(ghost()?.style.left).toBe("600px");
    expect(ghost()?.style.top).toBe("680px");
    expect(panel()?.getAttribute("data-mention-drop")).toBe("item");
    expect(hint()).toBe("Drop to insert this item");

    // Out again: the cue goes the moment the pointer leaves the panel.
    picker.drag("drag-move", OVER_THREAD);
    expect(panel()?.hasAttribute("data-mention-drop")).toBe(false);
    expect(hint()).not.toBe("Drop to insert this item");

    picker.drag("drag-move", OVER_COMPOSER);
    picker.drag("drag-end", OVER_COMPOSER);
    expect(ghost()).toBeNull();
    expect(panel()?.hasAttribute("data-mention-drop")).toBe(false);
    await waitFor(() =>
      expect(chipLabels()).toEqual(["Table mlb.lahman.batting, from Lakehouse Picker; remove"]),
    );
    expect(input.value).toBe("Count rows in");
    expect(input.selectionStart).toBe(5);
    expect(document.activeElement).toBe(focused);

    await user.click(input);
    await user.keyboard("{End}{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({
      content: "Count rows in",
      references: [{ name: "mlb.lahman.batting", kind: "table" }],
    });
  });

  it("a release anywhere else inserts nothing and says nothing", async () => {
    const picker = await openWithPicker(thread());
    const input = await placedComposer();
    picker.drag("drag-start", { item: TABLE, ...ON_ROW });
    picker.drag("drag-move", OVER_COMPOSER);
    picker.drag("drag-end", OVER_THREAD);
    expect(ghost()).toBeNull();
    expect(panel()?.hasAttribute("data-mention-drop")).toBe(false);
    expect(chips()).toHaveLength(0);
    expect(hint()).not.toBe(LAKEHOUSE_DROP_REFUSED);
    expect(input.value).toBe("");
  });

  it("a cancel clears the ghost and the cue; a later end does nothing", async () => {
    const picker = await openWithPicker(thread());
    await placedComposer();
    picker.drag("drag-start", { item: TABLE, ...ON_ROW });
    picker.drag("drag-move", OVER_COMPOSER);
    expect(panel()?.getAttribute("data-mention-drop")).toBe("item");
    picker.drag("drag-cancel", {});
    expect(ghost()).toBeNull();
    expect(panel()?.hasAttribute("data-mention-drop")).toBe(false);
    picker.drag("drag-end", OVER_COMPOSER);
    expect(chips()).toHaveLength(0);
  });

  it("a press in the page or Escape ends a drag whose end never came", async () => {
    const picker = await openWithPicker(thread());
    await placedComposer();
    picker.drag("drag-start", { item: TABLE, ...ON_ROW });
    picker.drag("drag-move", OVER_COMPOSER);
    fireEvent.pointerDown(document.body);
    expect(ghost()).toBeNull();
    expect(panel()?.hasAttribute("data-mention-drop")).toBe(false);
    picker.drag("drag-end", OVER_COMPOSER);
    expect(chips()).toHaveLength(0);

    picker.drag("drag-start", { item: TABLE, ...ON_ROW });
    expect(ghost()).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(ghost()).toBeNull();
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", 7])(
    "a hostile kind %s draws the generic icon and the chat keeps working",
    async (kind) => {
      const picker = await openWithPicker(thread());
      const input = await placedComposer();
      picker.drag("drag-start", { item: { kind, identifier: "x" }, ...ON_ROW });
      const g = must(ghost());
      expect(g.querySelector('[data-kobe-item-icon="generic"]')).not.toBeNull();
      expect(g.textContent).toContain("x");
      picker.drag("drag-end", OVER_COMPOSER);
      await waitFor(() => expect(hint()).toBe(LAKEHOUSE_DROP_REFUSED));
      expect(input.isConnected).toBe(true);
    },
  );

  it("an invalid item is refused with the KOBE-551 notice; nothing goes in (ac-4)", async () => {
    const user = userEvent.setup();
    const picker = await openWithPicker(thread());
    const input = await placedComposer();
    await user.type(input, "Hello");
    picker.drag("drag-start", { item: { ...TABLE, identifier: "mlb.lahman.pitching" }, ...ON_ROW });
    picker.drag("drag-move", OVER_COMPOSER);
    picker.drag("drag-end", OVER_COMPOSER);
    await waitFor(() => expect(hint()).toBe(LAKEHOUSE_DROP_REFUSED));
    expect(
      within(must(document.getElementById("kobe-composer-hint"))).getByRole("status").textContent,
    ).toBe(LAKEHOUSE_DROP_REFUSED);
    expect(input.value).toBe("Hello");
    expect(chips()).toHaveLength(0);
  });

  it("a full chip row shows the full notice (ac-4)", async () => {
    const picker = await openWithPicker(thread());
    await placedComposer();
    const links = Array.from({ length: ITEM_REFERENCES_MAX }, (_, i) => ({
      type: "resource_link",
      uri: `catalyst://lakehouse/mlb/lahman/t${i}`,
      name: `mlb.lahman.t${i}`,
      _meta: { "io.kobe/item-kind": "table" },
    }));
    picker.send({
      jsonrpc: "2.0",
      id: 3,
      method: "ui/message",
      params: { role: "user", content: links },
    });
    await waitFor(() => expect(chips()).toHaveLength(ITEM_REFERENCES_MAX));
    picker.drag("drag-start", { item: TABLE, ...ON_ROW });
    picker.drag("drag-end", OVER_COMPOSER);
    await waitFor(() => expect(hint()).toBe(LAKEHOUSE_DROP_FULL));
    expect(chips()).toHaveLength(ITEM_REFERENCES_MAX);
  });

  it.each([
    ["a shared thread read by another member", { readOnly: true }, /reading a shared conversation/],
    ["a thread in Trash", { trashed: true }, /This conversation is in Trash/],
  ])("%s shows no cue and takes no drop (ac-4)", async (_l, opts, banner) => {
    const picker = await openWithPicker(thread(opts));
    await screen.findByText(banner);
    expect(panel()).toBeNull();
    picker.drag("drag-start", { item: TABLE, ...ON_ROW });
    picker.drag("drag-move", OVER_COMPOSER);
    expect(document.querySelector("[data-mention-drop]")).toBeNull();
    picker.drag("drag-end", OVER_COMPOSER);
    expect(screen.queryByRole("list", { name: "Items sent with your next message" })).toBeNull();
  });
});
