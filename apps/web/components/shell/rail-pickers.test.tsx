// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { PREFERENCES_PATH } from "../../lib/shell/preferences";
import { RAIL_WIDTH_VAR } from "../../lib/shell/rail-width";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { chatRequests, composer, openApp } from "../chat/testing";
import { PICKER_RAIL_PX } from "./rail-pickers";

/**
 * KOBE-460 (spec MA3 as amended 2026-10-20): the Apps tab's Pickers section. A dropdown of the
 * member's live apps named "…Picker…" (and None), the choice kept per member; the chosen picker
 * runs live in the rail (the cards' frame route and bridge), its `ui/message` fills the draft on
 * screen and never sends, its context is a chip there, and its calls name the thread on screen.
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
});

const CONNECTOR = "11111111-1111-4111-8111-111111111111";
const app = (n: string, title: string) => ({
  appId: n.repeat(64),
  connectorId: CONNECTOR,
  connectorName: "Catalyst",
  iconUrl: null,
  tool: `open_${n}`,
  title,
  uri: `ui://catalyst/${n}`,
  sha256: "e".repeat(64),
});
const EXPLORER = app("a", "Lakehouse Explorer");
const PICKER = app("b", "Lakehouse Picker");
const QUERY_PICKER = app("c", "query picker");
const PICKER_FRAME = "Lakehouse Picker (app from Catalyst)";

function answered() {
  const t = fake.addThread("Tables");
  const u = fake.addEntry(t, null, { role: "user", content: "hello" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "hi" }] });
  return t;
}

async function appsTab(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("tab", { name: "Apps" }));
  return screen.findByRole("tabpanel", { name: "Apps" });
}
const pickerSelect = (section: HTMLElement) =>
  within(section).getByRole("combobox", { name: "Picker" }) as HTMLSelectElement;
const puts = () => fake.requests.filter((r) => r.method === "PUT" && r.path === PREFERENCES_PATH);
const appCalls = () =>
  fake.requests.filter((r) => r.method === "POST" && /^\/v1\/team\/apps\/.+\/calls$/.test(r.path));
const messages = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/messages"));
const railVar = () =>
  must(
    document.querySelector<HTMLElement>('[data-shell-region="rail"]')?.parentElement,
  ).style.getPropertyValue(RAIL_WIDTH_VAR);

/** The picker's frame, with a stand-in window to talk as the app. */
async function pickerWindow() {
  const frame = await waitFor(() => must(screen.queryByTitle(PICKER_FRAME)) as HTMLIFrameElement, {
    timeout: 4_000,
  });
  const child = { postMessage: vi.fn() } as unknown as Window;
  Object.defineProperty(frame, "contentWindow", { value: child, configurable: true });
  const send = (data: unknown) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source: child, origin: "null" }));
    });
  const replies = () =>
    (child.postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as unknown);
  return { frame, send, replies };
}

const uiMessage = (text: string) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "ui/message",
  params: { role: "user", content: [{ type: "text", text }] },
});

describe("the Pickers section (KOBE-460 ac-1, ac-2)", () => {
  it("is absent when the team has no live picker; the app list is unchanged", async () => {
    fake.teamApps = [EXPLORER];
    openApp(fake, answered());
    const section = await appsTab();
    expect(within(section).queryByRole("combobox", { name: "Picker" })).toBeNull();
    expect(
      within(section).getByRole("button", { name: "Open Lakehouse Explorer in this conversation" }),
    ).toBeTruthy();
  });

  it("sits above the list, offers None and the apps named Picker (any case); the list keeps every app", async () => {
    fake.teamApps = [EXPLORER, PICKER, QUERY_PICKER];
    openApp(fake, answered());
    const section = await appsTab();
    const select = pickerSelect(section);
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "None",
      "Lakehouse Picker",
      "query picker",
    ]);
    expect(select.value).toBe("");
    const list = must(section.querySelector("ul"));
    expect(select.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const name of ["Lakehouse Explorer", "Lakehouse Picker", "query picker"]) {
      expect(
        within(list).getByRole("button", { name: `Open ${name} in this conversation` }),
      ).toBeTruthy();
    }
    expect(screen.queryByTitle(PICKER_FRAME)).toBeNull();
  });

  it("remembers the choice per member (server-side) and renders it live; None removes it", async () => {
    fake.teamApps = [EXPLORER, PICKER];
    openApp(fake, answered());
    const section = await appsTab();
    await userEvent.setup().selectOptions(pickerSelect(section), PICKER.appId);
    await waitFor(() => expect(fake.preferences["rail_picker"]).toBe(PICKER.appId), {
      timeout: 3_000,
    });
    const frame = await waitFor(() => must(screen.queryByTitle(PICKER_FRAME)) as HTMLIFrameElement);
    // The cards' frame route and sandbox (ac-6).
    expect(frame.getAttribute("src")).toBe(
      `/v1/team/apps/${PICKER.appId}/frame?team=${fake.teamId}&sha256=${PICKER.sha256}`,
    );
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(must(frame.closest("[data-kobe-rail-picker]"))).toBeTruthy();

    await userEvent.setup().selectOptions(pickerSelect(section), "");
    await waitFor(() => expect(screen.queryByTitle(PICKER_FRAME)).toBeNull());
    await waitFor(() => expect(fake.preferences["rail_picker"]).toBeNull(), { timeout: 3_000 });
    expect(puts().length).toBeGreaterThanOrEqual(2);
  });

  it("opens on the stored picker", async () => {
    fake.teamApps = [EXPLORER, PICKER];
    fake.preferences = { rail_picker: PICKER.appId, rail_tab: "apps" };
    openApp(fake, answered());
    expect(await screen.findByTitle(PICKER_FRAME, undefined, { timeout: 4_000 })).toBeTruthy();
    expect(pickerSelect(await screen.findByRole("tabpanel", { name: "Apps" })).value).toBe(
      PICKER.appId,
    );
  });

  it("falls back to None with a note when the stored picker is no longer live", async () => {
    fake.teamApps = [EXPLORER, QUERY_PICKER];
    fake.preferences = { rail_picker: PICKER.appId, rail_tab: "apps" };
    openApp(fake, answered());
    const section = await screen.findByRole("tabpanel", { name: "Apps" });
    await waitFor(() => expect(pickerSelect(section).value).toBe(""));
    expect(within(section).getByText(/Your picker is no longer available/)).toBeTruthy();
    expect(screen.queryByTitle(PICKER_FRAME)).toBeNull();
    await waitFor(() => expect(fake.preferences["rail_picker"]).toBeNull(), { timeout: 3_000 });
  });
});

describe("the live picker (KOBE-460 ac-4, ac-6)", () => {
  it("fills the composer of the thread on screen, never sends, and its calls name that thread", async () => {
    fake.teamApps = [PICKER];
    fake.preferences = { rail_picker: PICKER.appId, rail_tab: "apps" };
    const t = answered();
    openApp(fake, t);
    const picker = await pickerWindow();
    const box = (await composer()) as HTMLTextAreaElement;
    await picker.send(uiMessage("Use table `c.n.t`"));
    await waitFor(() => expect(box.value).toBe("Use table `c.n.t`"));
    await waitFor(() =>
      expect(picker.replies()).toContainEqual({ jsonrpc: "2.0", id: 7, result: {} }),
    );
    expect(document.querySelector("[data-kobe-app-insert-from]")?.textContent).toContain(
      "From Lakehouse Picker",
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(messages()).toEqual([]);

    await picker.send({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "list_catalog_namespaces", arguments: {} },
    });
    await waitFor(() => expect(appCalls()).toHaveLength(1));
    expect(must(appCalls()[0]).body).toEqual({
      tool: "list_catalog_namespaces",
      arguments: {},
      thread_id: t,
    });
  });

  it("puts its context as a removable chip in the draft on screen", async () => {
    fake.teamApps = [PICKER];
    fake.preferences = { rail_picker: PICKER.appId, rail_tab: "apps" };
    openApp(fake, answered());
    const picker = await pickerWindow();
    await composer();
    await picker.send({
      jsonrpc: "2.0",
      id: 9,
      method: "ui/update-model-context",
      params: { content: [{ type: "text", text: "Table c.n.t" }] },
    });
    expect(await screen.findByText(/Context from Lakehouse Picker/)).toBeTruthy();
    expect(messages()).toEqual([]);
  });

  it("fills the new-conversation draft, and its calls name no thread", async () => {
    fake.teamApps = [PICKER];
    fake.preferences = { rail_picker: PICKER.appId, rail_tab: "apps" };
    openApp(fake);
    const picker = await pickerWindow();
    const box = (await composer()) as HTMLTextAreaElement;
    await picker.send(uiMessage("Use table `c.n.t`"));
    await waitFor(() => expect(box.value).toBe("Use table `c.n.t`"));
    await picker.send({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "list_catalog_namespaces", arguments: {} },
    });
    await waitFor(() => expect(appCalls()).toHaveLength(1));
    expect(must(appCalls()[0]).body).toEqual({ tool: "list_catalog_namespaces", arguments: {} });
    expect(chatRequests(fake, "POST")).toEqual([]);
  });

  it("is not run in a new conversation whose draft turned its connector off", async () => {
    fake.teamApps = [PICKER];
    fake.preferences = { rail_picker: PICKER.appId, rail_tab: "apps" };
    fake.chatConnectors.push({ connector_id: CONNECTOR, name: "Catalyst", problem: null });
    openApp(fake);
    await screen.findByTitle(PICKER_FRAME, undefined, { timeout: 4_000 });
    const user = userEvent.setup();
    (await screen.findByRole("button", { name: "Add to your message" })).focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    within(menu)
      .getByRole("menuitem", { name: /^Connectors/ })
      .focus();
    await user.keyboard("{ArrowRight}");
    const sub = await screen.findByRole("menu", { name: "Connectors" });
    await user.click(await within(sub).findByRole("menuitemcheckbox", { name: /Catalyst/ }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTitle(PICKER_FRAME)).toBeNull());
    expect(screen.getByText(/Catalyst is off in this conversation/)).toBeTruthy();
  });

  it("says so when a call finds the connector off in this conversation", async () => {
    fake.teamApps = [PICKER];
    fake.preferences = { rail_picker: PICKER.appId, rail_tab: "apps" };
    fake.appCallError = {
      status: 403,
      code: "connector_off",
      message: "This app's connector is off in this conversation.",
    };
    openApp(fake, answered());
    const picker = await pickerWindow();
    await picker.send({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "list_catalog_namespaces", arguments: {} },
    });
    expect(
      await screen.findByText(/Catalyst is off in this conversation/, undefined, {
        timeout: 4_000,
      }),
    ).toBeTruthy();
  });
});

describe("the rail's width with a picker (KOBE-460 ac-5)", () => {
  it("widens to at least 400 px while a picker shows, and None restores the member's width", async () => {
    fake.teamApps = [PICKER];
    openApp(fake, answered());
    const section = await appsTab();
    expect(railVar()).toBe("");
    await userEvent.setup().selectOptions(pickerSelect(section), PICKER.appId);
    await waitFor(() => expect(railVar()).toBe(`${PICKER_RAIL_PX}px`));
    // Not the member's width: nothing about it is saved.
    expect(fake.preferences["rail_width"]).toBeUndefined();
    await userEvent.setup().selectOptions(pickerSelect(section), "");
    await waitFor(() => expect(railVar()).toBe(""));
  });

  it("keeps a member's wider width, and comes back to their own after None", async () => {
    fake.teamApps = [PICKER];
    fake.preferences = { rail_width: 480, rail_tab: "apps" };
    openApp(fake, answered());
    const section = await screen.findByRole("tabpanel", { name: "Apps" });
    await waitFor(() => expect(railVar()).toBe("480px"));
    await userEvent.setup().selectOptions(pickerSelect(section), PICKER.appId);
    await new Promise((r) => setTimeout(r, 50));
    expect(railVar()).toBe("480px");
    await userEvent.setup().selectOptions(pickerSelect(section), "");
    await waitFor(() => expect(railVar()).toBe("480px"));
  });

  it("is not running while the Files tab is on screen; it comes back on Apps (LOW-2)", async () => {
    fake.teamApps = [PICKER];
    fake.preferences = { rail_picker: PICKER.appId, rail_tab: "apps" };
    openApp(fake, answered());
    expect(await screen.findByTitle(PICKER_FRAME, undefined, { timeout: 4_000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    await waitFor(() => expect(screen.queryByTitle(PICKER_FRAME)).toBeNull());
    await appsTab();
    expect(await screen.findByTitle(PICKER_FRAME)).toBeTruthy();
  });

  it("does not widen while the Files tab is on screen", async () => {
    fake.teamApps = [PICKER];
    fake.preferences = { rail_picker: PICKER.appId, rail_tab: "files" };
    openApp(fake, answered());
    await screen.findByRole("tab", { name: "Apps" });
    await new Promise((r) => setTimeout(r, 50));
    expect(railVar()).toBe("");
    await appsTab();
    await waitFor(() => expect(railVar()).toBe(`${PICKER_RAIL_PX}px`));
  });
});
