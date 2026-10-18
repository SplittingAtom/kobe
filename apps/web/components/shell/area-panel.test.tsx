// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { consolePortalContainer } from "../ui/chat-portal";
import { composer, openApp } from "../chat/testing";

/**
 * KOBE-424 (CE4, U18): My memory, My approvals, My schedules and My connectors open beside the
 * thread in the artifact column, with the conversation and its composer still on screen; `?area=`
 * keeps the thread and makes deep links, a refresh and Back/Forward work. Under 768 px the panel
 * is a full-screen sheet with Back. The builders, Projects and My shared cases stay full pages.
 */
let fake: FakeKobe;
let fetchSpy: typeof fetch;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  // The My area pages' own endpoints (the chat's fake answers /v1/me and /v1/team).
  fetchSpy = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://kobe.test");
    const json = (body: unknown) => Response.json(body);
    if (url.pathname === "/v1/team/policy/my-rules") return json({ rules: [] });
    if (url.pathname === "/v1/me/time-zone") return json({ time_zone: "Europe/Paris" });
    if (url.pathname === "/v1/memory") return json({ docs: [] });
    return fake.fetch(input, init);
  }) as typeof fetch;
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  resizeWindow(DESKTOP_WIDTH);
  vi.unstubAllGlobals();
});

const area = () => document.querySelector<HTMLElement>("[data-kobe-area]");
const params = () => new URLSearchParams(window.location.search);
const barLink = (command: string) =>
  must(document.querySelector<HTMLElement>(`[data-command="${command}"]`));

async function openThread() {
  const t = fake.addThread("Forecast");
  openApp(fake, t);
  await screen.findByRole("heading", { level: 2, name: "Forecast" });
  return t;
}

describe("My area pages beside the thread (KOBE-424 ac-1)", () => {
  it("My memory from the bar opens in the artifact column; the thread and composer stay", async () => {
    const t = await openThread();
    await userEvent.setup().click(barLink("my-memory"));
    const panel = await screen.findByRole("region", { name: "My memory" });
    expect(panel.closest('[data-shell-region="artifact"]')).not.toBeNull();
    // The frame is the chat's; the page inside is a console root (the console's own styling).
    expect(panel.hasAttribute("data-kobe-console")).toBe(false);
    await waitFor(() => expect(panel.querySelector("[data-kobe-console]")).not.toBeNull());
    // Its dialogs and menus mount at the document's top, outside the chat (over the bar).
    const portal = must(consolePortalContainer());
    expect(portal.parentElement).toBe(document.body);
    expect(portal.closest("[data-kobe-chat]")).toBeNull();
    expect(portal.hasAttribute("data-kobe-console")).toBe(true);
    expect(window.location.pathname).toBe("/");
    expect(params().get("thread")).toBe(t);
    expect(params().get("area")).toBe("memory");
    expect(await composer()).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Forecast" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(panel));
  });

  it("My approvals from the profile menu opens beside, closes the menu, and shows the page", async () => {
    const t = await openThread();
    const user = userEvent.setup();
    await user.click(barLink("profile"));
    await user.click(screen.getByRole("link", { name: "My approvals" }));
    const panel = await screen.findByRole("region", { name: "My approvals" });
    expect(params().get("thread")).toBe(t);
    expect(params().get("area")).toBe("approvals");
    expect(barLink("profile").closest("details")?.open).toBe(false);
    // The page's own content, under the panel's heading (its h1 is left out there).
    expect(
      await within(panel).findByRole("heading", { name: "Remembered approvals" }),
    ).toBeTruthy();
    expect(within(panel).queryByRole("heading", { level: 1 })).toBeNull();
    expect(await composer()).toBeTruthy();
  });

  it("My connectors and My schedules open beside; My skills, Projects and My agents stay pages", async () => {
    await openThread();
    const user = userEvent.setup();
    await user.click(barLink("profile"));
    await user.click(screen.getByRole("link", { name: "My connectors" }));
    expect(await screen.findByRole("region", { name: "My connectors" })).toBeTruthy();
    await user.click(barLink("my-schedules"));
    expect(await screen.findByRole("region", { name: "My schedules" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "My connectors" })).toBeNull();
    await user.click(barLink("profile"));
    expect(screen.getByRole("link", { name: "My skills" }).getAttribute("href")).toBe("/me/skills");
    expect(barLink("my-agents").getAttribute("href")).toBe("/me/agents");
  });

  it("Close returns to the conversation, which keeps its thread", async () => {
    const t = await openThread();
    const user = userEvent.setup();
    await user.click(barLink("my-memory"));
    const panel = await screen.findByRole("region", { name: "My memory" });
    await user.click(within(panel).getByRole("button", { name: "Close My memory" }));
    await waitFor(() => expect(area()).toBeNull());
    expect(params().get("area")).toBeNull();
    expect(params().get("thread")).toBe(t);
    expect(document.activeElement?.id).toBe("kobe-chat-main");
  });
});

describe("deep links and history (KOBE-424 ac-2)", () => {
  it("a link with ?area= opens the page beside the thread it names", async () => {
    const t = fake.addThread("Forecast");
    window.history.replaceState(null, "", `/?thread=${t}&area=approvals`);
    openApp(fake, t);
    // openApp sets ?thread= only: put the area back as a deep link would have it.
    act(() => {
      window.history.replaceState(null, "", `/?thread=${t}&area=approvals`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("region", { name: "My approvals" })).toBeTruthy();
    expect(await composer()).toBeTruthy();
  });

  it("Back closes it and Forward opens it again; Escape closes it", async () => {
    await openThread();
    const user = userEvent.setup();
    await user.click(barLink("my-memory"));
    await screen.findByRole("region", { name: "My memory" });
    act(() => {
      window.history.back();
    });
    await waitFor(() => expect(area()).toBeNull());
    act(() => {
      window.history.forward();
    });
    const panel = await screen.findByRole("region", { name: "My memory" });
    panel.focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(area()).toBeNull());
  });

  it("Close after an open from the thread goes back: Back then never reopens it", async () => {
    await openThread();
    const user = userEvent.setup();
    const before = window.history.length;
    await user.click(barLink("my-memory"));
    // Another page from the open one takes its entry: still one step from the thread.
    await user.click(barLink("my-schedules"));
    const panel = await screen.findByRole("region", { name: "My schedules" });
    expect(window.history.length).toBe(before + 1);
    await user.click(within(panel).getByRole("button", { name: "Close My schedules" }));
    await waitFor(() => expect(area()).toBeNull());
    expect(params().get("area")).toBeNull();
    act(() => window.history.back());
    await new Promise((r) => setTimeout(r, 50));
    expect(params().get("area")).toBeNull();
    expect(area()).toBeNull();
  });

  it("Close after a deep link replaces its entry: Back leaves, it doesn't reopen", async () => {
    const t = fake.addThread("Forecast");
    openApp(fake, t);
    act(() => {
      window.history.replaceState(null, "", `/?thread=${t}&area=memory`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const panel = await screen.findByRole("region", { name: "My memory" });
    const before = window.history.length;
    await userEvent.setup().click(within(panel).getByRole("button", { name: "Close My memory" }));
    await waitFor(() => expect(area()).toBeNull());
    expect(window.history.length).toBe(before);
    expect(window.location.search).toBe(`?thread=${t}`);
  });

  it("an unknown ?area= opens nothing", async () => {
    const t = fake.addThread("Forecast");
    openApp(fake, t);
    act(() => {
      window.history.replaceState(null, "", `/?thread=${t}&area=skills`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await screen.findByRole("heading", { level: 2, name: "Forecast" });
    expect(area()).toBeNull();
  });

  it("a modifier click keeps the full page (a new tab)", async () => {
    await openThread();
    const link = barLink("my-memory");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    link.dispatchEvent(click);
    expect(params().get("area")).toBeNull();
    expect(link.getAttribute("href")).toBe("/me/memory");
  });
});

describe("on a phone (KOBE-424 ac-2)", () => {
  it("is a full-screen sheet with Back to the conversation", async () => {
    resizeWindow(390);
    await openThread();
    const user = userEvent.setup();
    await user.click(barLink("my-memory"));
    const sheet = await screen.findByRole("dialog", { name: "My memory" });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(
      must(document.querySelector('[data-shell-region="artifact"]')).hasAttribute(
        "data-sheet-open",
      ),
    ).toBe(true);
    await user.click(within(sheet).getByRole("button", { name: "Back to the conversation" }));
    await waitFor(() => expect(area()).toBeNull());
    expect(await composer()).toBeTruthy();
    // The system Back right after the sheet's own Back doesn't bring the sheet back.
    act(() => window.history.back());
    await new Promise((r) => setTimeout(r, 50));
    expect(area()).toBeNull();
    expect(params().get("area")).toBeNull();
  });

  it("opened from the profile menu, closing the sheet leaves focus in the conversation", async () => {
    resizeWindow(390);
    await openThread();
    const user = userEvent.setup();
    await user.click(barLink("thread-menu")); // the phone bar's Menu holds the profile menu
    await user.click(barLink("profile"));
    await user.click(screen.getByRole("link", { name: "My approvals" }));
    const sheet = await screen.findByRole("dialog", { name: "My approvals" });
    await user.click(within(sheet).getByRole("button", { name: "Back to the conversation" }));
    await waitFor(() => expect(area()).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("from 768 to 820 px it is the column's sheet over the conversation", async () => {
    resizeWindow(800);
    await openThread();
    await userEvent.setup().click(barLink("my-memory"));
    const sheet = await screen.findByRole("region", { name: "My memory" });
    expect(
      must(document.querySelector('[data-shell-region="artifact"]')).hasAttribute(
        "data-sheet-open",
      ),
    ).toBe(true);
    expect(within(sheet).getByRole("button", { name: "Back to the conversation" })).toBeTruthy();
    expect(await composer()).toBeTruthy();
  });
});
