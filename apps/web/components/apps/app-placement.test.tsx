// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { openApp } from "../chat/testing";
import { BRIDGE_ATTACHED_ATTR } from "./app-frame";

/**
 * KOBE-531 (spec MA3 as amended 2026-10-31): a site admin places an app. `chat` is the card as
 * before; `artifacts` opens the card's app in the artifact column by itself (the card shows the
 * stub), live and on a reopened thread, one tab per card with the newest active, within the
 * thread's 3 live frames; closing the tab returns the frame to the card; under 820 px nothing
 * opens by itself. An app's `ui/request-display-mode` never moves a frame (ac-7).
 */
let fake: FakeKobe;

afterEach(() => {
  cleanup();
  resizeWindow(DESKTOP_WIDTH);
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
  resizeWindow(DESKTOP_WIDTH);
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

const CONNECTOR = "11111111-1111-4111-8111-111111111111";
const app = (n: string, title: string, placement: string) => ({
  appId: n.repeat(64),
  connectorId: CONNECTOR,
  connectorName: "Catalyst",
  iconUrl: null,
  tool: `open_${n}`,
  title,
  uri: `ui://catalyst/${n}`,
  sha256: "e".repeat(64),
  placement,
});
const QUERY = app("a", "Lake Query", "artifacts");
const EXPLORER = app("b", "Lakehouse Explorer", "chat");
const frameTitle = (title: string) => `${title} (app from Catalyst)`;

function answered() {
  const t = fake.addThread("Tables");
  const u = fake.addEntry(t, null, { role: "user", content: "hello" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "hi" }] });
  return t;
}

const column = () => screen.queryByRole("tablist", { name: "Open artifacts" });
const tabNames = () =>
  column()
    ? within(must(column()))
        .queryAllByRole("tab")
        .map((t) => `${t.textContent}${t.getAttribute("aria-selected") === "true" ? "*" : ""}`)
    : [];
const cards = () => [...document.querySelectorAll<HTMLElement>("[data-kobe-app-card-entry]")];
const inColumn = (f: Element) => f.closest("[role=tabpanel]") !== null;

describe("app placement in the conversation (KOBE-531 ac-5)", () => {
  it("chat: the card renders its app as before, nothing opens in the column", async () => {
    const t = answered();
    fake.addAppCard(t, EXPLORER);
    openApp(fake, t);
    const frame = await waitFor(() => must(screen.queryByTitle(frameTitle(EXPLORER.title))), {
      timeout: 4_000,
    });
    expect(inColumn(frame)).toBe(false);
    expect(tabNames()).toEqual([]);
    expect(screen.getByRole("button", { name: "Expand" })).toBeTruthy();
  });

  it("artifacts on a reopened thread: one tab per card, newest active, the cards show the stub", async () => {
    const t = answered();
    fake.addAppCard(t, QUERY);
    fake.addAppCard(t, { ...QUERY, title: "Lake Query 2" });
    fake.addAppCard(t, EXPLORER);
    openApp(fake, t);
    await waitFor(() => expect(tabNames()).toEqual(["Lake Query", "Lake Query 2*"]), {
      timeout: 4_000,
    });
    const [first, second, third] = cards();
    await within(must(first)).findByText("Opened in the side column");
    await within(must(second)).findByText("Opened in the side column");
    // The chat card renders inline beside them: three live frames in all.
    await waitFor(() =>
      expect(within(must(third)).getByTitle(frameTitle(EXPLORER.title))).toBeTruthy(),
    );
    const frames = screen.queryAllByTitle(/app from Catalyst/);
    expect(frames).toHaveLength(3);
    expect(frames.filter(inColumn)).toHaveLength(2);
    // Opening the thread reads the results; it never calls the upstream.
    expect(fake.requests.some((r) => r.path.endsWith("/calls"))).toBe(false);
  });

  it("closing the tab returns the frame to the card, and it stays there", async () => {
    const t = answered();
    fake.addAppCard(t, QUERY);
    openApp(fake, t);
    await waitFor(() => expect(tabNames()).toEqual(["Lake Query*"]), { timeout: 4_000 });
    fireEvent.click(screen.getByRole("button", { name: "Close Lake Query" }));
    const card = must(cards()[0]);
    await waitFor(() => expect(within(card).getByTitle(frameTitle(QUERY.title))).toBeTruthy(), {
      timeout: 4_000,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(tabNames()).toEqual([]);
    expect(within(card).queryByText("Opened in the side column")).toBeNull();
    expect(within(card).getByRole("button", { name: "Expand" })).toBeTruthy();
  });

  it("a rail launch of an artifacts app opens its tab at once (the card is the stub)", async () => {
    fake.teamApps = [QUERY];
    const t = answered();
    openApp(fake, t);
    fireEvent.click(await screen.findByRole("tab", { name: "Apps" }));
    const section = await screen.findByRole("tabpanel", { name: "Apps" });
    await userEvent
      .setup()
      .click(within(section).getByRole("button", { name: "Open Lake Query in this conversation" }));
    await waitFor(() => expect(tabNames()).toEqual(["Lake Query*"]), { timeout: 4_000 });
    const card = await waitFor(() => must(cards()[0]));
    await within(card).findByText("Opened in the side column");
    expect(screen.queryAllByTitle(frameTitle(QUERY.title)).filter(inColumn)).toHaveLength(1);
  });

  it("keeps the thread's 3 live frames: only the newest 3 placed cards open", async () => {
    const t = answered();
    for (const n of [1, 2, 3, 4]) fake.addAppCard(t, { ...QUERY, title: `Query ${n}` });
    openApp(fake, t);
    await waitFor(() => expect(tabNames()).toEqual(["Query 2", "Query 3", "Query 4*"]), {
      timeout: 4_000,
    });
    // The oldest card's inline frame is retired (after ui/resource-teardown) for the newest.
    await waitFor(() => expect(screen.queryAllByTitle(/app from Catalyst/)).toHaveLength(3), {
      timeout: 4_000,
    });
    const oldest = must(cards()[0]);
    expect(within(oldest).queryByText("Opened in the side column")).toBeNull();
  });

  it("under 820 px nothing opens by itself: the card keeps Expand", async () => {
    resizeWindow(600);
    const t = answered();
    fake.addAppCard(t, QUERY);
    openApp(fake, t);
    const card = await waitFor(() => must(cards()[0]), { timeout: 4_000 });
    await waitFor(() => expect(within(card).getByTitle(frameTitle(QUERY.title))).toBeTruthy(), {
      timeout: 4_000,
    });
    expect(within(card).getByRole("button", { name: "Expand" })).toBeTruthy();
    expect(within(card).queryByText("Opened in the side column")).toBeNull();
    expect(tabNames()).toEqual([]);
  });
});

describe("an app's display-mode request never moves it (KOBE-531 ac-7)", () => {
  it("answers the current mode for an artifacts app; nothing opens or closes", async () => {
    const t = answered();
    fake.addAppCard(t, QUERY);
    openApp(fake, t);
    await waitFor(() => expect(tabNames()).toEqual(["Lake Query*"]), { timeout: 4_000 });
    const frame = await waitFor(
      () => {
        const f = must(screen.queryAllByTitle(frameTitle(QUERY.title)).find(inColumn));
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
    await send({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/request-display-mode",
      params: { mode: "inline" },
    });
    await send({
      jsonrpc: "2.0",
      id: 2,
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });
    await waitFor(() =>
      expect((child.postMessage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2),
    );
    const replies = (child.postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: 1, result: { mode: "fullscreen" } },
      { jsonrpc: "2.0", id: 2, result: { mode: "fullscreen" } },
    ]);
    await new Promise((r) => setTimeout(r, 200));
    expect(tabNames()).toEqual(["Lake Query*"]);
    const card = must(cards()[0]);
    expect(within(card).getByText("Opened in the side column")).toBeTruthy();
    expect(within(card).queryByTitle(frameTitle(QUERY.title))).toBeNull();
  });
});
