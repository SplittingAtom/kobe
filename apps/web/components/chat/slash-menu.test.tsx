// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
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
const sent = () => messagePosts().map((r) => (r.body as { content?: string }).content);

async function opened(t: string) {
  openApp(fake, t);
  await screen.findByText("They add up to 42.");
  // The bar's row two (Compact now, the model) publishes its actions once the thread was read.
  await waitFor(
    () =>
      expect(document.querySelector('summary[aria-label="Conversation actions"]')).not.toBeNull(),
    WAIT,
  );
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
      "/memory, My memory",
      "/schedules, My schedules",
      "/agents, My agents",
      "/files, Files",
      "/compact, Compact this thread",
      "/model model, Model for this conversation",
      "/new, New conversation",
      "/copy, Copy",
      "/regenerate, Regenerate",
      "/regenerate-with model, Regenerate with",
      "/pin, Pin",
      "/move project, Move to project, unavailable: You have no projects to move it to.",
      "/archive, Archive",
      "/share with, Share",
      "/rename, Rename",
      "/fork, Fork to a new thread",
      "/stop, Stop, unavailable: Nothing is running.",
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
    await waitFor(() =>
      expect(document.querySelector("[data-kobe-slash-status]")?.textContent).toBe(
        "Stop: Nothing is running.",
      ),
    );
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
