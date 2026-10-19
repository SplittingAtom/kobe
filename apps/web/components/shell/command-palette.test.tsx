// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "../chat/chat-app";
import { chatRequests, composer, openApp } from "../chat/testing";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { paletteActions } from "../../lib/shell/palette";
import { isMacPlatform } from "../../lib/shell/shortcuts";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";

/**
 * KOBE-225 (CE23, ac-1): Ctrl/Cmd+K opens the palette, a modal dialog with a combobox over one
 * grouped list of the registry's actions, thread titles and workspace file names. Actions run
 * through the same live bindings as their buttons and the `/` menu; threads and files open.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push(
    { alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true },
    { alias: "glm", label: "GLM 5.3", enabled: true, is_default: false },
  );
  fake.workspaceFiles.set("reports/summary.md", new Uint8Array([104, 105]));
  fake.workspaceFiles.set("data/sales q3.csv", new Uint8Array(10));
  vi.stubGlobal("fetch", fake.fetch);
  resizeWindow(DESKTOP_WIDTH);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function conversation(title = "Report") {
  const t = fake.addThread(title);
  const first = fake.addSystemEntry(t, null, "model_change", { provider: "kobe", modelId: "kimi" });
  const root = fake.addSystemEntry(t, first, "thinking_level_change", { thinkingLevel: "off" });
  const q = fake.addEntry(t, root, { role: "user", content: "Sum the numbers" });
  // A reasoning block, so the answer has a Show details toggle to watch (KOBE-418).
  fake.addEntry(t, q, {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Adding up." },
      { type: "text", text: "They add up to 42." },
    ],
  });
  return { t, root };
}

async function ready() {
  await screen.findByText("They add up to 42.", undefined, WAIT);
  await screen.findByRole("combobox", { name: "Model for this conversation" }, WAIT);
}

const mod = () => (isMacPlatform() ? { metaKey: true } : { ctrlKey: true });

async function openPalette() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "k", code: "KeyK", ...mod() });
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  const input = within(dialog).getByRole("combobox") as HTMLInputElement;
  return { dialog, input, list: within(dialog).getByRole("listbox") };
}

const optionNames = (el: HTMLElement) =>
  within(el)
    .queryAllByRole("option")
    .map((o) => o.getAttribute("aria-label"));
const group = (dialog: HTMLElement, name: string) => within(dialog).getByRole("group", { name });
const messagePosts = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/messages"));
const threadParam = () => new URL(window.location.href).searchParams.get("thread");

describe("the palette (ac-1)", { timeout: 30_000 }, () => {
  it("is a modal dialog with a combobox over a listbox; focus is trapped and returns", async () => {
    const { t } = conversation();
    openApp(fake, t);
    await ready();
    const before = screen.getByRole("button", { name: "Show details" });
    before.focus();
    const { dialog, input, list } = await openPalette();
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    const options = within(list).getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(input.getAttribute("aria-activedescendant")).toBe(options.at(-1)?.id);
    // The focus stays in the dialog.
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(before));
  });

  it("lists every registered action, named with its key or why it can't run", async () => {
    const { t } = conversation();
    openApp(fake, t);
    await ready();
    const { dialog } = await openPalette();
    const actions = group(dialog, "Actions");
    const names = optionNames(actions);
    const expected = paletteActions({}, { readOnly: false }).map((a) => a.command.id);
    expect(names).toHaveLength(expected.length);
    const mac = isMacPlatform();
    expect(names).toContain(mac ? "New conversation, ⌘N" : "New conversation, Ctrl+N");
    expect(names).toContain("Stop, unavailable: Nothing is running.");
    expect(names).toContain("My memory");
    expect(names).toContain(mac ? "Collapse the rail, ⌘B" : "Collapse the rail, Ctrl+B");
    // The palette's own command is not listed in it.
    expect(names.some((n) => n?.startsWith("Search actions"))).toBe(false);
  });

  it("finds an action by any of its words and runs its binding", async () => {
    const { t } = conversation();
    openApp(fake, t);
    await ready();
    // The answer's own Show details follows the conversation-wide toggle (KOBE-418).
    const toggle = screen.getByRole("button", { name: "Show details" });
    const { dialog } = await openPalette();
    const user = userEvent.setup();
    await user.keyboard("details show");
    await waitFor(() =>
      expect(optionNames(group(dialog, "Actions"))[0]).toMatch(/^Show all details/),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
  });

  it("a known action that can't run says why, runs nothing and stays open", async () => {
    const { t } = conversation();
    openApp(fake, t);
    await ready();
    const { dialog } = await openPalette();
    const user = userEvent.setup();
    await user.keyboard("stop");
    await waitFor(() =>
      expect(optionNames(group(dialog, "Actions"))).toEqual([
        "Stop, unavailable: Nothing is running.",
      ]),
    );
    await user.keyboard("{Enter}");
    await within(dialog).findByText("Stop: Nothing is running.");
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBe(dialog);
    expect(chatRequests(fake, "POST")).toEqual([]);
  });

  it("an action with choices lists them next; a pick runs the choice (Regenerate with)", async () => {
    const { t, root } = conversation();
    openApp(fake, t);
    await ready();
    const { dialog } = await openPalette();
    const user = userEvent.setup();
    await user.keyboard("regenerate with{Enter}");
    const choices = await within(dialog).findByRole("listbox", { name: "Regenerate with" });
    await waitFor(() =>
      expect(optionNames(choices)).toEqual([
        "Team default (Kimi K2.7 Code), current",
        "Kimi K2.7 Code",
        "GLM 5.3",
      ]),
    );
    // Backspace on an empty query goes back to the actions, Escape too.
    await user.keyboard("{Backspace}");
    await within(dialog).findByRole("listbox", { name: "Results" });
    await user.keyboard("regenerate with{Enter}");
    await within(dialog).findByRole("listbox", { name: "Regenerate with" });
    await user.keyboard("{Escape}");
    await within(dialog).findByRole("listbox", { name: "Results" });
    await user.keyboard("regenerate with{Enter}glm{Enter}");
    await waitFor(() => expect(messagePosts()).toHaveLength(1));
    expect(fake.threads.get(t)?.model).toBe("glm");
    expect(messagePosts()[0]?.body).toEqual({ content: "Sum the numbers", parent_entry_id: root });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an action that moves the focus keeps it (Edit your last message)", async () => {
    const { t } = conversation();
    openApp(fake, t);
    await ready();
    await openPalette();
    await userEvent.setup().keyboard("edit your last{Enter}");
    const edit = await screen.findByLabelText("Edit your message");
    await waitFor(() => expect(document.activeElement).toBe(edit));
  });

  it("opens a thread found by its title", async () => {
    const { t } = conversation();
    const budget = fake.addThread("Budget 2027");
    const q = fake.addEntry(budget, null, { role: "user", content: "plan" });
    fake.addEntry(budget, q, { role: "assistant", content: [{ type: "text", text: "Planned." }] });
    openApp(fake, t);
    await ready();
    const { dialog } = await openPalette();
    await userEvent.setup().keyboard("budget");
    const threads = await within(dialog).findByRole("group", { name: "Threads" }, WAIT);
    expect(optionNames(threads)).toEqual(["Budget 2027"]);
    fireEvent.click(within(threads).getByRole("option", { name: "Budget 2027" }));
    await screen.findByText("Planned.", undefined, WAIT);
    expect(threadParam()).toBe(budget);
  });

  it("opens a workspace file in the artifact column", async () => {
    const { t } = conversation();
    openApp(fake, t);
    await ready();
    const { dialog } = await openPalette();
    await userEvent.setup().keyboard("summary");
    const files = await within(dialog).findByRole("group", { name: "Files" }, WAIT);
    expect(optionNames(files)).toEqual(["summary.md, reports"]);
    await userEvent.setup().keyboard("{ArrowDown}");
    const option = within(files).getByRole("option", { name: "summary.md, reports" });
    await waitFor(() => expect(option.getAttribute("aria-selected")).toBe("true"));
    await userEvent.setup().keyboard("{Enter}");
    await screen.findByRole("tab", { name: "summary.md", selected: true }, WAIT);
  });

  it("debounces the searches: a word typed at speed is one request of each", async () => {
    const { t } = conversation();
    openApp(fake, t);
    await ready();
    const { dialog } = await openPalette();
    const before = fake.requests.length;
    await userEvent.setup().keyboard("summary");
    await within(dialog).findByRole("group", { name: "Files" }, WAIT);
    const searches = fake.requests.slice(before).map((r) => r.path);
    expect(searches.filter((p) => p.startsWith("/v1/workspace/files/search?"))).toEqual([
      "/v1/workspace/files/search?q=summary&limit=8",
    ]);
    expect(searches.filter((p) => p.startsWith("/v1/threads?q="))).toEqual([
      "/v1/threads?q=summary",
    ]);
  });

  it("Enter right after typing never opens a result of the previous query", async () => {
    const { t } = conversation();
    const budget = fake.addThread("Budget 2027");
    fake.addEntry(budget, null, { role: "user", content: "plan" });
    openApp(fake, t);
    await ready();
    const { dialog } = await openPalette();
    const user = userEvent.setup();
    await user.keyboard("budget");
    await within(dialog).findByRole("group", { name: "Threads" }, WAIT);
    // The next query's answers are not in yet: the old rows are gone, Enter opens nothing.
    await user.keyboard(" zz{Enter}");
    expect(within(dialog).queryByRole("group", { name: "Threads" })).toBeNull();
    await new Promise((r) => setTimeout(r, 400));
    expect(threadParam()).toBe(t);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBe(dialog);
  });

  it("searches from two letters, and aborts the requests a newer query replaces", async () => {
    const { t } = conversation();
    const signals: { path: string; signal: AbortSignal | undefined }[] = [];
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const inner = fake.fetch;
    const fetchFn: typeof fetch = async (input, init) => {
      const path = String(input);
      if (path.includes("q=")) {
        signals.push({ path, signal: init?.signal ?? undefined });
        await held;
      }
      return inner(input, init);
    };
    vi.stubGlobal("fetch", fetchFn);
    window.history.replaceState(null, "", `/?thread=${t}`);
    render(<ChatApp fetchFn={fetchFn} eventSource={fake.eventSource} reopenDelayMs={() => 0} />);
    await ready();
    const { dialog } = await openPalette();
    const user = userEvent.setup();
    await user.keyboard("s");
    await new Promise((r) => setTimeout(r, 400));
    expect(signals).toEqual([]);
    expect(within(dialog).getByText(/Type two letters or more/)).toBeTruthy();
    await user.keyboard("u");
    await waitFor(() => expect(signals).toHaveLength(2), WAIT);
    await user.keyboard("m");
    await waitFor(() => expect(signals).toHaveLength(4), WAIT);
    expect(signals.slice(0, 2).map((s) => s.signal?.aborted)).toEqual([true, true]);
    expect(signals.slice(2).map((s) => s.signal?.aborted)).toEqual([false, false]);
    release();
    await within(dialog).findByRole("group", { name: "Files" }, WAIT);
  });

  it("navigation commands go where their links go, client-side", async () => {
    const push = vi.fn();
    const router = { push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() };
    const { t } = conversation();
    window.history.replaceState(null, "", `/?thread=${t}`);
    render(
      <AppRouterContext.Provider
        value={router as unknown as ComponentProps<typeof AppRouterContext.Provider>["value"]}
      >
        <ChatApp fetchFn={fake.fetch} eventSource={fake.eventSource} reopenDelayMs={() => 0} />
      </AppRouterContext.Provider>,
    );
    await ready();
    await openPalette();
    await userEvent.setup().keyboard("my agents{Enter}");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/me/agents"));
    // CE4 (KOBE-424): My memory opens beside the thread, not as a page.
    await openPalette();
    await userEvent.setup().keyboard("my memory{Enter}");
    expect(await screen.findByRole("region", { name: "My memory" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("thread")).toBe(t);
    expect(push).not.toHaveBeenCalledWith("/me/memory");
  });

  it("a reader of a shared thread can't run the owner's actions from it", async () => {
    const { t } = conversation();
    const thread = must(fake.threads.get(t));
    thread.read_only = true;
    openApp(fake, t);
    await screen.findByText("They add up to 42.", undefined, WAIT);
    await screen.findByText(/You are reading a shared conversation/, undefined, WAIT);
    const { dialog } = await openPalette();
    await userEvent.setup().keyboard("pin");
    await waitFor(() =>
      expect(optionNames(group(dialog, "Actions"))[0]).toMatch(/^Pin, unavailable: /),
    );
    expect(await composer().catch(() => null)).toBeNull();
  });
});
