// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { ComponentProps } from "react";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { ChatApp } from "./chat-app";
import { chatRequests, composer, openApp } from "./testing";

/**
 * KOBE-224 (CE22): `/` at the start of the composer opens a listbox of the registry's actions
 * that are bound now; a pick runs the button's own handler and removes the `/` text; an unknown
 * word is sent as an ordinary message.
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
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** An idle thread with one exchange, under Pi's first model and settings entries. */
function conversation(title = "Report") {
  const t = fake.addThread(title);
  const first = fake.addSystemEntry(t, null, "model_change", { provider: "kobe", modelId: "kimi" });
  const root = fake.addSystemEntry(t, first, "thinking_level_change", { thinkingLevel: "off" });
  const question = fake.addEntry(t, root, { role: "user", content: "Sum the numbers" });
  fake.addEntry(t, question, {
    role: "assistant",
    content: [{ type: "text", text: "They add up to 42." }],
  });
  return { t, root };
}

const menu = () => screen.findByRole("listbox", { name: "Actions" }, WAIT);
const noMenu = () => expect(screen.queryByRole("listbox")).toBeNull();
const messagePosts = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/messages"));
/** What the menu last said to screen readers (a no-break space marks a repeat). */
const slashStatus = () =>
  (document.querySelector("[data-kobe-slash-status]")?.textContent ?? "").replace(/\u00a0/g, "");
const sent = () => messagePosts().map((r) => (r.body as { content?: string }).content);

async function opened(t: string) {
  openApp(fake, t);
  await screen.findByText("They add up to 42.");
  // The latest answer's Compact now and the composer's model picker show once the thread was read
  // and their actions are published (KOBE-418).
  await screen.findByRole("button", { name: "Compact now" }, WAIT);
  await screen.findByRole("combobox", { name: "Model for this conversation" }, WAIT);
  return composer();
}

describe("the / menu lists the bound actions (ac-1)", { timeout: 30_000 }, () => {
  it("lists actions with their arguments as a combobox listbox; arrows move the highlight", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/");
    const list = await menu();
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    const options = within(list).getAllByRole("option");
    const names = options.map((o) => o.getAttribute("aria-label"));
    // Registry order; each binding's own state (no projects to move to yet).
    expect(names).toEqual([
      "/files, Files",
      "/compact, Compact this thread",
      "/model model, Model for this conversation",
      "/new, New conversation",
      "/copy, Copy",
      "/regenerate, Regenerate",
      "/regenerate-with model, Regenerate with",
      "/pin, Pin",
      "/unpin, Unpin, unavailable: It isn't pinned.",
      "/move project, Move to project, unavailable: You have no projects to move it to.",
      "/archive, Archive",
      "/unarchive, Unarchive, unavailable: It isn't archived.",
      "/share with, Share",
      "/skill, Make a skill from this",
      "/saveskill skill, Save skill to Workbench, unavailable: No skill folder in /workspace/skills yet: ask skill-creator to build one.",
      "/rename, Rename",
      "/fork, Fork to a new thread",
      "/stop, Stop, unavailable: Nothing is running.",
      "/memory, My memory",
      "/schedules, My schedules",
      "/agents, My agents",
      "/skills, Skills",
    ]);
    // Stop is listed but unavailable while nothing runs.
    const stop = within(list).getByRole("option", { name: /^\/stop/ });
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(stop.getAttribute("aria-label")).toBe("/stop, Stop, unavailable: Nothing is running.");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    await user.keyboard("{ArrowUp}");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
  });

  it("/compact opens the same dialog as the Compact button, and leaves no text (ac-3)", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/comp");
    const list = await menu();
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["/compactCompact this thread"]);
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Compact this thread" })).toBeTruthy();
    expect(input.value).toBe("");
    expect(messagePosts()).toEqual([]);
  });

  it("/fork opens the answer's Fork dialog for the last answer", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/fork");
    await menu();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Fork to a new thread" });
    expect(within(dialog).getByText(/up to this answer/)).toBeTruthy();
    expect(input.value).toBe("");
  });

  it("Tab completes an argument; picking a choice runs the menu's own handler (ac-3)", async () => {
    const { t, root } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/regenerate-w");
    await menu();
    await user.keyboard("{Tab}");
    await waitFor(() => expect(input.value).toBe("/regenerate-with "));
    const choices = await screen.findByRole("listbox", { name: "model for /regenerate-with" });
    expect(
      within(choices)
        .getAllByRole("option")
        .map((o) => o.getAttribute("aria-label")),
    ).toEqual(["Team default (Kimi K2.7 Code), current", "Kimi K2.7 Code", "GLM 5.3"]);
    await user.type(input, "glm");
    await waitFor(() =>
      expect(
        within(choices)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["GLM 5.3"]),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(messagePosts()).toHaveLength(1));
    // Regenerate with: the model is saved first, then the last prompt is sent again.
    expect(fake.threads.get(t)?.model).toBe("glm");
    expect(messagePosts()[0]?.body).toEqual({ content: "Sum the numbers", parent_entry_id: root });
    expect(input.value).toBe("");
    noMenu();
  });

  it("/move lists the projects and moves the thread as the row menu's Move does", async () => {
    const q4 = fake.addProject("Q4");
    fake.addProject("Ops");
    const { t } = conversation("Budget");
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/move ");
    const choices = await screen.findByRole("listbox", { name: "project for /move" }, WAIT);
    await waitFor(() =>
      expect(
        within(choices)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["No projectcurrent", "Q4", "Ops"]),
    );
    await user.type(input, "q4{Enter}");
    await waitFor(() => expect(fake.threads.get(t)?.project_id).toBe(q4));
    expect(input.value).toBe("");
    await waitFor(() =>
      expect(document.querySelector("[data-kobe-thread-commands]")?.textContent).toBe(
        "Moved “Budget” to Q4. Its instructions apply from the next message.",
      ),
    );
  });

  it("an action that can't run now stays in the composer, with the reason spoken", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/stop");
    await menu();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(slashStatus()).toBe("Stop: Nothing is running."));
    expect(input.value).toBe("/stop");
    expect(messagePosts()).toEqual([]);
  });

  it("Escape closes the menu and keeps the text", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/comp");
    await menu();
    await user.keyboard("{Escape}");
    await waitFor(noMenu);
    expect(input.value).toBe("/comp");
  });
});

describe("text that is no action is a message (ac-2)", { timeout: 30_000 }, () => {
  it("an unknown /word lists nothing and Enter sends it as text", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/hello there");
    noMenu();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent()).toEqual(["/hello there"]));
  });

  it("a / inside a message never opens the menu", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "see /comp");
    noMenu();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sent()).toEqual(["see /comp"]));
  });

  it("opens after leading whitespace, not on a later line", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "  /comp");
    await menu();
    await user.clear(input);
    await user.type(input, "hi{Shift>}{Enter}{/Shift}/comp");
    noMenu();
  });
});

describe("a known /word is never sent as a message (CE22)", { timeout: 30_000 }, () => {
  it("in a new conversation, /compact lists why it waits and Enter sends nothing", async () => {
    openApp(fake);
    const input = await composer();
    const user = userEvent.setup();
    await user.type(input, "/compact");
    const option = within(await menu()).getByRole("option", { name: /^\/compact/ });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(slashStatus()).toMatch(/^Compact this thread: /));
    expect(input.value).toBe("/compact");
    expect(chatRequests(fake, "POST")).toEqual([]);
  });

  it("/new works at phone width too, where the rail is a drawer", async () => {
    const { t } = conversation();
    resizeWindow(390);
    try {
      openApp(fake, t);
      await screen.findByText("They add up to 42.");
      const input = await composer();
      const user = userEvent.setup();
      await user.type(input, "/new");
      await menu();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(new URLSearchParams(window.location.search).get("thread")).toBeNull(),
      );
      expect(messagePosts()).toEqual([]);
    } finally {
      resizeWindow(DESKTOP_WIDTH);
    }
  });

  it("a known word whose argument matches nothing keeps a no-match row; Enter sends nothing", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/model gml");
    const list = await screen.findByRole("listbox", { name: "model for /model" }, WAIT);
    expect(within(list).getByRole("option").textContent).toBe("No model matches “gml”.");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(slashStatus()).toBe("No model matches “gml”."));
    expect(input.value).toBe("/model gml");
    await user.keyboard("{Enter}");
    expect(input.value).toBe("/model gml");
    expect(messagePosts()).toEqual([]);
  });

  it("Enter on a bare / picks nothing until the list is moved through", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/");
    await menu();
    await user.keyboard("{Enter}");
    expect(input.value).toBe("/");
    await menu();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.keyboard("{ArrowDown}{Enter}");
    // The second entry, Compact, ran.
    expect(await screen.findByRole("dialog", { name: "Compact this thread" })).toBeTruthy();
    expect(input.value).toBe("");
  });
});

describe("how the text arrives (ac-3)", { timeout: 30_000 }, () => {
  it("one fast burst, /compact and Enter, runs Compact and sends nothing", async () => {
    const { t } = conversation();
    const input = await opened(t);
    await userEvent.setup({ delay: null }).type(input, "/compact{Enter}");
    expect(await screen.findByRole("dialog", { name: "Compact this thread" })).toBeTruthy();
    expect(input.value).toBe("");
    expect(messagePosts()).toEqual([]);
  });

  it("a pasted /compact opens the menu; Enter runs it", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.click(input);
    await user.paste("/compact");
    await menu();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Compact this thread" })).toBeTruthy();
    expect(messagePosts()).toEqual([]);
  });

  it("Enter while an IME composes is the IME's, not a pick", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/comp");
    await menu();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(input);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(input.value).toBe("/comp");
    expect(messagePosts()).toEqual([]);
  });

  it("a click pick keeps the focus in the composer", async () => {
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/pin");
    await user.click(within(await menu()).getByRole("option", { name: /^\/pin,/ }));
    await waitFor(() => expect(fake.threads.get(t)?.pinned_at).toBeTruthy());
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("after a thread switch, an action runs on the thread now open", async () => {
    const { t: first } = conversation("First");
    const { t: second } = conversation("Second");
    const input = await opened(first);
    const user = userEvent.setup();
    const row = await waitFor(() =>
      must(document.querySelector<HTMLElement>(`[data-kobe-thread="${second}"]`)),
    );
    await user.click(within(row).getByText("Second"));
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("thread")).toBe(second),
    );
    await screen.findByRole("heading", { name: "Second" });
    const now = await composer();
    await user.type(now, "/pin");
    await menu();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fake.threads.get(second)?.pinned_at).toBeTruthy());
    expect(fake.threads.get(first)?.pinned_at ?? null).toBeNull();
    expect(input).toBeTruthy();
  });

  it("an unknown /word with an @ mention is sent as text with the mention listed", async () => {
    fake.workspaceFiles.set("reports/summary.md", new Uint8Array(10));
    const { t } = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "/hello see @sum");
    await user.click(
      within(await screen.findByRole("listbox", { name: "Workspace files" })).getByRole("option", {
        name: /summary\.md/,
      }),
    );
    await waitFor(() => expect(input.value).toBe("/hello see @file(reports/summary.md) "));
    noMenu();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(messagePosts()).toHaveLength(1));
    expect(messagePosts()[0]?.body).toMatchObject({
      content: "/hello see @file(reports/summary.md)",
      mentions: ["reports/summary.md"],
    });
  });
});

describe("navigation actions (S2)", { timeout: 30_000 }, () => {
  it("/memory navigates client-side and keeps the draft's attachments", async () => {
    const push = vi.fn();
    const router = {
      push,
      replace: vi.fn(),
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn(),
    };
    const { t } = conversation();
    window.history.replaceState(null, "", `/?thread=${t}`);
    const transport: NonNullable<ComponentProps<typeof ChatApp>["uploadTransport"]> = () =>
      new Promise(() => {});
    render(
      <AppRouterContext.Provider
        value={router as unknown as ComponentProps<typeof AppRouterContext.Provider>["value"]}
      >
        <ChatApp
          fetchFn={fake.fetch}
          eventSource={fake.eventSource}
          reopenDelayMs={() => 0}
          uploadTransport={transport}
        />
      </AppRouterContext.Provider>,
    );
    const user = userEvent.setup();
    const input = await composer();
    await user.upload(
      await screen.findByLabelText("Choose files to attach"),
      new File(["a"], "a.txt"),
    );
    await screen.findByRole("list", { name: "Attached files" });
    await user.type(input, "/mem");
    await menu();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/me/memory"));
    expect(screen.getByRole("list", { name: "Attached files" })).toBeTruthy();
  });
});
