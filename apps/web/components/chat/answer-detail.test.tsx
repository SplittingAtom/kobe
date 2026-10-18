// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { PREFERENCES_PATH } from "../../lib/shell/preferences";
import { must } from "../../lib/testing/must";
import { openApp, pressModShift } from "./testing";

/**
 * KOBE-418 ac-3: Show details per answer. An icon toggle (aria-pressed) beside Fork opens or
 * closes only that answer's reasoning and tool cards; Mod+Shift+D (and the palette) still toggle
 * every block, and a block set by hand keeps its state until a toggle changes (useDisclosure).
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push({ alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** One turn: think, run a tool, answer `text`. Returns the answer's last entry. */
function turn(t: string, parent: string | null, n: number, text: string): string {
  const q = fake.addEntry(t, parent, { role: "user", content: `Question ${n}` });
  const step = fake.addEntry(t, q, {
    role: "assistant",
    content: [
      { type: "thinking", thinking: `Plan ${n}.` },
      { type: "toolCall", id: `tc${n}`, name: "bash", arguments: { command: `echo ${n}` } },
    ],
  });
  const result = fake.addEntry(t, step, {
    role: "toolResult",
    toolCallId: `tc${n}`,
    toolName: "bash",
    content: [{ type: "text", text: `out ${n}` }],
    isError: false,
  });
  return fake.addEntry(t, result, { role: "assistant", content: [{ type: "text", text }] });
}

function twoAnswers(): string {
  const t = fake.addThread("Steps");
  turn(t, turn(t, null, 1, "First answer."), 2, "Second answer.");
  return t;
}

const answerOf = async (text: string) =>
  must((await screen.findByText(text, {}, WAIT)).closest<HTMLElement>('[data-role="assistant"]'));
const disclosures = (root: HTMLElement) =>
  within(root)
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded") && !b.hasAttribute("aria-haspopup"));
const expanded = (root: HTMLElement) =>
  disclosures(root).map((d) => d.getAttribute("aria-expanded"));
const puts = () => fake.requests.filter((r) => r.method === "PUT" && r.path === PREFERENCES_PATH);
const toggleOf = (root: HTMLElement) => within(root).getByRole("button", { name: "Show details" });
const toggleAll = () => pressModShift("D");

describe("Show details per answer (KOBE-418 ac-3)", { timeout: 30_000 }, () => {
  it("is offered only on answers with something to open, not on plain text", async () => {
    const t = fake.addThread("Mixed");
    const q = fake.addEntry(t, null, { role: "user", content: "Hello" });
    const plain = fake.addEntry(t, q, {
      role: "assistant",
      content: [{ type: "text", text: "Just text." }],
    });
    turn(t, plain, 2, "With steps.");
    openApp(fake, t);
    const text = await answerOf("Just text.");
    const steps = await answerOf("With steps.");
    expect(within(steps).getByRole("button", { name: "Show details" })).toBeTruthy();
    expect(within(text).queryByRole("button", { name: "Show details" })).toBeNull();
    // Fork is still there on the plain answer.
    expect(within(text).getByRole("button", { name: "Fork to a new thread" })).toBeTruthy();
  });

  it("sits beside Fork on each answer, before the thumbs", async () => {
    openApp(fake, twoAnswers());
    for (const text of ["First answer.", "Second answer."]) {
      const answer = await answerOf(text);
      const names = within(answer)
        .getAllByRole("button")
        .filter((b) => !b.hasAttribute("aria-expanded"))
        .map((b) => b.getAttribute("aria-label"));
      const fork = names.indexOf("Fork to a new thread");
      expect(fork).toBeGreaterThan(-1);
      expect(names[fork + 1]).toBe("Show details");
      expect(toggleOf(answer).getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("opens and closes only its own answer's reasoning and tool cards", async () => {
    openApp(fake, twoAnswers());
    const first = await answerOf("First answer.");
    const second = await answerOf("Second answer.");
    expect(expanded(first)).toEqual(["false", "false"]);
    const user = userEvent.setup();
    await user.click(toggleOf(first));
    expect(toggleOf(first).getAttribute("aria-pressed")).toBe("true");
    expect(expanded(first)).toEqual(["true", "true"]);
    expect(expanded(second)).toEqual(["false", "false"]);
    expect(toggleOf(second).getAttribute("aria-pressed")).toBe("false");
    await user.click(toggleOf(first));
    expect(toggleOf(first).getAttribute("aria-pressed")).toBe("false");
    expect(expanded(first)).toEqual(["false", "false"]);
    // One answer's choice is not the member's stored Detail preference (Mod+Shift+D's).
    await new Promise((r) => setTimeout(r, 900));
    expect(puts()).toEqual([]);
  });

  it("Mod+Shift+D still toggles every block in every answer; the toggles follow", async () => {
    openApp(fake, twoAnswers());
    const first = await answerOf("First answer.");
    const second = await answerOf("Second answer.");
    const user = userEvent.setup();
    await user.click(toggleOf(first));
    toggleAll();
    await waitFor(() => expect(expanded(second)).toEqual(["true", "true"]));
    expect(expanded(first)).toEqual(["true", "true"]);
    expect(toggleOf(second).getAttribute("aria-pressed")).toBe("true");
    // One answer closed on its own; the shortcut then closes everything.
    await user.click(toggleOf(second));
    expect(expanded(second)).toEqual(["false", "false"]);
    expect(expanded(first)).toEqual(["true", "true"]);
    toggleAll();
    await waitFor(() => expect(expanded(first)).toEqual(["false", "false"]));
    expect(expanded(second)).toEqual(["false", "false"]);
    expect(toggleOf(first).getAttribute("aria-pressed")).toBe("false");
  });

  it("a block set by hand keeps its state until a toggle of its answer changes", async () => {
    openApp(fake, twoAnswers());
    const first = await answerOf("First answer.");
    const second = await answerOf("Second answer.");
    const user = userEvent.setup();
    await user.click(must(disclosures(second)[0]));
    expect(expanded(second)).toEqual(["true", "false"]);
    // Another answer's toggle leaves it alone.
    await user.click(toggleOf(first));
    expect(expanded(second)).toEqual(["true", "false"]);
    // Its own toggle sets every block of its answer.
    await user.click(toggleOf(second));
    expect(expanded(second)).toEqual(["true", "true"]);
    await user.click(toggleOf(second));
    expect(expanded(second)).toEqual(["false", "false"]);
  });
});
