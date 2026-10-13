// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { PREFERENCES_PATH } from "../../lib/shell/preferences";
import { must } from "../../lib/testing/must";
import { openApp } from "../chat/testing";

/** KOBE-202 (CE8): the member's layout, loaded at shell start and saved per user. */
let fake: FakeKobe;
let innerWidth: number;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
  innerWidth = window.innerWidth;
  // 1,280 px: 1,000 px right of the 280 px rail.
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: innerWidth });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rail = () => screen.getByRole("complementary", { name: "Workspace" });
const divider = () => screen.getByRole("separator", { name: "Resize Threads and Files" });
const puts = () => fake.requests.filter((r) => r.method === "PUT" && r.path === PREFERENCES_PATH);
const loads = () => fake.requests.filter((r) => r.method === "GET" && r.path === PREFERENCES_PATH);
const gridWidth = () =>
  must(
    document.querySelector<HTMLElement>('[data-shell-region="artifact"]')?.parentElement,
  ).style.getPropertyValue("--kobe-artifact-width");

async function openShell() {
  const before = loads().length;
  openApp(fake);
  await screen.findByRole("complementary", { name: "Workspace" });
  await waitFor(() => expect(loads()).toHaveLength(before + 1));
}

function narrowScreen() {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) => ({ matches: query.includes("max-width"), media: query }) as MediaQueryList,
  );
}

async function openArtifact() {
  const t = fake.addThread("Reports");
  const u = fake.addEntry(t, null, { role: "user", content: "make it" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  fake.addArtifact(t, { kind: "markdown", title: "Plan", versions: ["Plan body"] });
  openApp(fake, t);
  const list = await screen.findByRole("navigation", { name: "Artifacts in this conversation" });
  await userEvent.setup().click(within(list).getByRole("button", { name: "Plan" }));
  await screen.findByRole("tab", { name: "Plan", selected: true });
}

describe("loading (ac-1)", () => {
  it("applies what the member saved, loaded once at shell start", async () => {
    fake.preferences = { rail_collapsed: false, threads_share: 0.4 };
    await openShell();
    await waitFor(() => expect(divider().getAttribute("aria-valuenow")).toBe("40"));
    expect(rail().hasAttribute("data-collapsed")).toBe(false);
    expect(loads()).toHaveLength(1);
  });

  it("follows the member to another browser: saved here, applied there", async () => {
    await openShell();
    const user = userEvent.setup();
    divider().focus();
    await user.keyboard("{ArrowUp}{ArrowUp}"); // 50%, two key presses: one PUT
    await user.click(within(rail()).getByRole("button", { name: "Collapse the rail" }));
    await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 });
    expect(puts()[0]?.body).toEqual({ threads_share: 0.5, rail_collapsed: true });
    cleanup();

    // Another browser, same member: the server is the only thing the two share.
    sessionStorage.clear();
    localStorage.clear();
    await openShell();
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
    await user.click(within(rail()).getByRole("button", { name: "Show threads" }));
    await waitFor(() => expect(divider().getAttribute("aria-valuenow")).toBe("50"));
  });

  it("applies a stored artifact width that fits this window", async () => {
    fake.preferences = { artifact_width: 600 }; // 600 + the conversation's 400 = 1,000
    await openArtifact();
    await waitFor(() => expect(gridWidth()).toBe("600px"));
  });
});

describe("saving", () => {
  it("saves the artifact width the member resized to, debounced into one PUT", async () => {
    await openArtifact();
    const box = (left: number, width: number) =>
      ({ left, width, right: left + width, top: 0, height: 800, x: left, y: 0 }) as DOMRect;
    const region = (name: string) =>
      must(document.querySelector<HTMLElement>(`[data-shell-region="${name}"]`));
    vi.spyOn(region("artifact"), "getBoundingClientRect").mockReturnValue(box(280, 500));
    vi.spyOn(region("conversation"), "getBoundingClientRect").mockReturnValue(box(780, 500));
    const handle = screen.getByRole("separator", {
      name: "Resize the artifact column and the conversation",
    });
    handle.focus();
    await userEvent.setup().keyboard("{ArrowRight}{ArrowRight}");
    expect(gridWidth()).toBe("524px"); // measured at 500 px each press (mocked)
    await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 });
    expect(puts()[0]?.body).toEqual({ artifact_width: 524 });
    expect(fake.preferences).toEqual({ artifact_width: 524 });
  });
});

describe("values that no longer fit (ac-3)", () => {
  it("ignores a width the window can't hold and a share out of bounds: the defaults apply", async () => {
    fake.preferences = { artifact_width: 700, threads_share: 0.95 };
    await openArtifact();
    await waitFor(() => expect(loads()).toHaveLength(1));
    expect(gridWidth()).toBe(""); // half the space (CSS default)
    expect(divider().getAttribute("aria-valuenow")).toBe("60");
  });

  it("keeps the rail collapsed on a narrow screen, and doesn't save its drawer", async () => {
    narrowScreen();
    fake.preferences = { rail_collapsed: false };
    await openShell();
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(true));
    const user = userEvent.setup();
    await user.click(within(rail()).getByRole("button", { name: "Show threads" }));
    await waitFor(() => expect(rail().hasAttribute("data-collapsed")).toBe(false));
    await new Promise((r) => setTimeout(r, 900));
    expect(puts()).toHaveLength(0);
  });

  it("keeps the defaults when loading fails, logs it and still works", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fake.failNext.set(
      `GET ${PREFERENCES_PATH}`,
      Response.json({ code: "server_error" }, { status: 500 }),
    );
    await openShell();
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(divider().getAttribute("aria-valuenow")).toBe("60");
    expect(rail().hasAttribute("data-collapsed")).toBe(false);
  });
});
