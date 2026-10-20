// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { chatRequests, composer, openApp } from "./testing";

/**
 * KOBE-418 ac-1/ac-2: the bar has no row two; the conversation's Agent, Model and Thinking
 * selectors sit in the composer's toolbar after Attach. On a narrow composer (a phone, or the
 * column squeezed beside the rail and an artifact) they fold into one "Agent and model" menu, so
 * the toolbar stays one line and Send stays on it.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };
/** The composer panel's laid-out width (mocked; happy-dom has no layout). 0: not measured. */
let panelWidth = 0;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push(
    { alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true },
    {
      alias: "glm",
      label: "GLM 5.3",
      enabled: true,
      is_default: false,
      thinking_in_team: { default: "low", levels: ["off", "low", "medium"] },
    },
  );
  fake.runnableAgents.push({ id: "a-ledger", scope: "team", name: "Ledger Bot", model: null });
  vi.stubGlobal("fetch", fake.fetch);
  panelWidth = 0;
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.hasAttribute("data-kobe-composer-panel")) return real.call(this);
    return { left: 0, top: 0, x: 0, y: 0, width: panelWidth, height: 80 } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  resizeWindow(DESKTOP_WIDTH);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const toolbar = () =>
  waitFor(() => must(document.querySelector<HTMLElement>("[data-composer-toolbar]")), WAIT);
/** The line under the composer (KOBE-418 gauge; KOBE-450 the selectors after the first prompt). */
const footer = () =>
  waitFor(() => must(document.querySelector<HTMLElement>("[data-composer-footer]")), WAIT);

/** The toolbar's controls in order, by accessible name (a select by its label). */
function controlNames(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>("button, select")]
    .filter((el) => el.closest("[hidden]") === null)
    .map((el) =>
      el.tagName === "SELECT"
        ? (el.closest("label")?.querySelector("span")?.textContent ?? "")
        : (el.getAttribute("aria-label") ?? el.textContent ?? ""),
    );
}

describe("the bar keeps row one only (ac-1)", () => {
  it("has no row two, no conversation context group and no Files button", async () => {
    openApp(fake);
    await composer();
    expect(document.querySelector('[data-bar-row="1"]')).not.toBeNull();
    expect(document.querySelector('[data-bar-row="2"]')).toBeNull();
    expect(screen.queryByRole("group", { name: "Conversation context" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
  });
});

describe("the composer's selectors (ac-2)", { timeout: 30_000 }, () => {
  it("a new conversation: Attach, then Chat with, Model and (for a model that has it) Thinking", async () => {
    openApp(fake);
    const bar = await toolbar();
    await within(bar).findByRole("button", { name: "Chat with: No agent" }, WAIT);
    const model = await within(bar).findByRole("combobox", {
      name: "Model for this conversation",
    });
    expect(
      within(bar).queryByRole("combobox", { name: "Thinking level for this conversation" }),
    ).toBeNull();
    await userEvent.setup().selectOptions(model, "glm");
    await within(bar).findByRole("combobox", { name: "Thinking level for this conversation" });
    const names = controlNames(bar);
    expect(names.slice(0, 4)).toEqual([
      "Attach files",
      "Chat with: No agent",
      "Model for this conversation",
      "Thinking level for this conversation",
    ]);
    expect(names.at(-1)).toBe("Send");
  });

  it("the agent picker opens its radios from the composer and the choice is sent", async () => {
    openApp(fake);
    const user = userEvent.setup();
    const bar = await toolbar();
    await user.click(await within(bar).findByRole("button", { name: "Chat with: No agent" }, WAIT));
    const choices = await screen.findByRole("radiogroup", { name: "Chat with" });
    await user.click(within(choices).getByRole("radio", { name: /Ledger Bot/ }));
    await user.keyboard("{Escape}");
    expect(within(bar).getByRole("button", { name: "Chat with: Ledger Bot" })).toBeTruthy();
    await user.type(await composer(), "reconcile{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    expect(chatRequests(fake, "POST")[0]).toMatchObject({ body: { agent_id: "a-ledger" } });
    // Once the conversation exists (KOBE-450 ac-5) its agent is today's fixed chip, on the line
    // below the composer: only its position moved.
    const below = await footer();
    expect(await within(below).findByText("Agent: Ledger Bot", {}, WAIT)).toBeTruthy();
    expect(within(bar).queryByText("Agent: Ledger Bot")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Chat with:/ })).toBeNull();
  });

  it("a conversation shared with you read-only: the reader's banner, no selectors", async () => {
    const t = fake.addThread("Shared");
    const q = fake.addEntry(t, null, { role: "user", content: "Sum" });
    fake.addEntry(t, q, { role: "assistant", content: [{ type: "text", text: "42." }] });
    must(fake.threads.get(t)).read_only = true;
    openApp(fake, t);
    expect(await screen.findByText(/You are reading a shared conversation/, {}, WAIT)).toBeTruthy();
    expect(document.querySelector("[data-composer-toolbar]")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Model for this conversation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Agent and model" })).toBeNull();
  });
});

describe("narrow composers fold the selectors into one menu (ac-2)", { timeout: 30_000 }, () => {
  it("on a phone: one Agent and model button; the menu holds the pickers; Escape closes it", async () => {
    resizeWindow(390);
    openApp(fake);
    const bar = await toolbar();
    const button = await within(bar).findByRole("button", { name: "Agent and model" }, WAIT);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const menu = must(document.getElementById(must(button.getAttribute("aria-controls"))));
    // Folded, the pickers stay mounted (their `/model` binding too), hidden in the menu: not
    // displayed (the chat has no preflight `[hidden]` rule) and out of the accessibility tree.
    expect(menu.hidden).toBe(true);
    // happy-dom loads no Tailwind, so check what wins in a browser too: an inline display:none,
    // and no display utility class that would beat the browser's own `[hidden]` rule.
    expect(menu.style.display).toBe("none");
    expect(menu.className).not.toMatch(/\b(flex|block|grid)\b/);
    expect(getComputedStyle(menu).display).toBe("none");
    expect(
      within(menu).queryByRole("combobox", { name: "Model for this conversation" }),
    ).toBeNull();
    expect(
      await within(menu).findByRole("combobox", {
        name: "Model for this conversation",
        hidden: true,
      }),
    ).toBeTruthy();
    // One line: Attach, the menu, then Send at the end.
    expect(controlNames(bar)).toEqual(["Attach files", "Agent and model", "Send"]);
    const user = userEvent.setup();
    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(menu.hidden).toBe(false);
    expect(getComputedStyle(menu).display).not.toBe("none");
    expect(within(menu).getByRole("button", { name: "Chat with: No agent" })).toBeTruthy();
    await user.selectOptions(
      within(menu).getByRole("combobox", { name: "Model for this conversation" }),
      "glm",
    );
    expect(
      await within(menu).findByRole("combobox", { name: "Thinking level for this conversation" }),
    ).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    within(menu).getByRole("combobox", { name: "Model for this conversation" }).focus();
    await user.keyboard("{Escape}");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(getComputedStyle(menu).display).toBe("none");
    expect(document.activeElement).toBe(button);
  });

  it("closes when the focus leaves the menu, not when it moves inside it", async () => {
    resizeWindow(390);
    openApp(fake);
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "Agent and model" }, WAIT);
    await user.click(button);
    const menu = must(document.getElementById(must(button.getAttribute("aria-controls"))));
    act(() => within(menu).getByRole("combobox", { name: "Model for this conversation" }).focus());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    act(() => document.getElementById("kobe-composer")?.focus());
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(getComputedStyle(menu).display).toBe("none");
  });

  it("a press outside closes the menu; the agent's popover inside it does not", async () => {
    resizeWindow(390);
    openApp(fake);
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "Agent and model" }, WAIT);
    await user.click(button);
    const menu = must(document.getElementById(must(button.getAttribute("aria-controls"))));
    await user.click(within(menu).getByRole("button", { name: "Chat with: No agent" }));
    const choices = await screen.findByRole("radiogroup", { name: "Chat with" });
    await user.click(within(choices).getByRole("radio", { name: /Ledger Bot/ }));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Escape}"); // the agent popover
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await user.click(await composer());
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("folds when the column is squeezed (beside the rail and an artifact) and unfolds as it grows", async () => {
    panelWidth = 480;
    openApp(fake);
    const bar = await toolbar();
    expect(await within(bar).findByRole("button", { name: "Agent and model" }, WAIT)).toBeTruthy();
    panelWidth = 900;
    act(() => {
      fireEvent(window, new Event("resize"));
    });
    await waitFor(() =>
      expect(within(bar).queryByRole("button", { name: "Agent and model" })).toBeNull(),
    );
    expect(within(bar).getByRole("combobox", { name: "Model for this conversation" })).toBeTruthy();
  });
});

/** A started conversation: agent Ledger Bot on GLM, which offers thinking levels. */
function startedThread(): string {
  const t = fake.addThread("Books");
  const q = fake.addEntry(t, null, { role: "user", content: "Sum" });
  fake.addEntry(t, q, { role: "assistant", content: [{ type: "text", text: "42." }] });
  Object.assign(must(fake.threads.get(t)), {
    agent_id: "a-ledger",
    agent_name: "Ledger Bot",
    model: "glm",
  });
  return t;
}

describe(
  "after the first prompt the selectors sit below the composer (KOBE-450)",
  { timeout: 30_000 },
  () => {
    it("ac-1: below, before the right-aligned gauge; the toolbar keeps Attach and Send", async () => {
      openApp(fake, startedThread());
      const bar = await toolbar();
      const below = await footer();
      await within(below).findByRole("combobox", { name: "Model for this conversation" }, WAIT);
      const selectors = must(below.querySelector<HTMLElement>('[data-composer-selectors="below"]'));
      expect(controlNames(selectors)).toEqual([
        "Model for this conversation",
        "Thinking level for this conversation",
      ]);
      expect(within(selectors).getByText("Agent: Ledger Bot")).toBeTruthy();
      // Selectors first, the gauge last (pushed right); the line wraps instead of overflowing.
      const gauge = must(below.querySelector<HTMLElement>("[data-composer-gauge]"));
      expect(
        selectors.compareDocumentPosition(gauge) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(gauge.className).toMatch(/\bms-auto\b/);
      expect(below.className).toMatch(/\bflex-wrap\b/);
      expect(controlNames(bar)).toEqual(["Attach files", "Send"]);
      expect(within(bar).queryByRole("button", { name: "Agent and model" })).toBeNull();
    });

    it("ac-1: behaviour unchanged: model and thinking still save on the thread", async () => {
      const t = startedThread();
      openApp(fake, t);
      const below = await footer();
      const user = userEvent.setup();
      const thinking = await within(below).findByRole(
        "combobox",
        { name: "Thinking level for this conversation" },
        WAIT,
      );
      await user.selectOptions(thinking, "off");
      await waitFor(() => expect(fake.threads.get(t)?.thinking_level).toBe("off"));
      await user.selectOptions(
        within(below).getByRole("combobox", { name: "Model for this conversation" }),
        "kimi",
      );
      await waitFor(() => expect(fake.threads.get(t)?.model).toBe("kimi"));
    });

    it("ac-1: on a phone they stay inline below (no fold menu), every control reachable", async () => {
      resizeWindow(390);
      openApp(fake, startedThread());
      const bar = await toolbar();
      const below = await footer();
      const model = await within(below).findByRole(
        "combobox",
        { name: "Model for this conversation" },
        WAIT,
      );
      expect(model.closest("[hidden]")).toBeNull();
      expect(
        within(below).getByRole("combobox", { name: "Thinking level for this conversation" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Agent and model" })).toBeNull();
      expect(controlNames(bar)).toEqual(["Attach files", "Send"]);
    });

    it("ac-5: the agent keeps today's rules after the first prompt: a fixed chip, never a picker", async () => {
      openApp(fake, startedThread());
      const below = await footer();
      expect(await within(below).findByText("Agent: Ledger Bot", {}, WAIT)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^Chat with:/ })).toBeNull();
    });
  },
);
