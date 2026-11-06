// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPARING } from "../../lib/chat/compare";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { isMacPlatform } from "../../lib/shell/shortcuts";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { announcement, chatRequests, openApp } from "./testing";

/** KOBE-547 (CT10, CT19): Compare versions side by side. */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
  resizeWindow(DESKTOP_WIDTH);
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const say = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

const usage = (runId: string, prompt: string, model: string, input: number) => ({
  run_id: runId,
  user_entry_id: prompt,
  models: [model],
  calls: 1,
  input_tokens: input,
  output_tokens: 7,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
  unpriced_calls: 1,
  estimated_calls: 0,
});

/**
 * Three versions of the second prompt: v1 (a tool call, then "answer one"), v2 a regenerate (same
 * text, a Markdown answer), v3 an edit (the leaf). Each version's run ended, so each is rateable.
 */
function versionedThread(options: { readOnly?: boolean; test?: boolean } = {}) {
  const t = fake.addThread("Budget 2027");
  const u1 = fake.addEntry(t, null, { role: "user", content: "start" });
  const a1 = fake.addEntry(t, u1, say("a1"));
  const v1 = fake.addEntry(t, a1, { role: "user", content: "the question" });
  const step = fake.addEntry(t, v1, {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "plan.md" } }],
  });
  const result = fake.addEntry(t, step, {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "write",
    content: [{ type: "text", text: "written" }],
    isError: false,
  });
  const b1 = fake.addEntry(t, result, say("answer one"));
  const v2 = fake.addEntry(t, a1, { role: "user", content: "the question" });
  const b2 = fake.addEntry(t, v2, say("answer **two**"));
  const v3 = fake.addEntry(t, a1, { role: "user", content: "an edited question" });
  const b3 = fake.addEntry(t, v3, say("answer three"));
  const runs = [v1, v2, v3].map((v) => fake.addEndedRun(t, v));
  fake.threadUsage.set(t, [
    usage(must(runs[0]), v1, "model-one", 101),
    usage(must(runs[1]), v2, "model-two", 202),
    usage(must(runs[2]), v3, "model-three", 303),
  ]);
  const thread = must(fake.threads.get(t));
  if (options.readOnly) {
    Object.assign(thread, { read_only: true, visibility: "team", owner_name: "Ann" });
  }
  if (options.test) thread.is_test = true;
  return { t, v1, v2, v3, b1, b2, b3, runs };
}

const dialog = () => screen.queryByRole("dialog", { name: "Compare versions" });
const column = (name: string | RegExp) => within(must(dialog())).getByRole("region", { name });
const regionNames = () =>
  [...must(dialog()).querySelectorAll("[data-kobe-compare-column]")].map((r) =>
    r.getAttribute("aria-label"),
  );
const leafPosts = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/leaf"));
const bar = () => screen.queryByRole("region", { name: "Another branch" });

async function opened(t: string) {
  openApp(fake, t);
  await screen.findByText("answer three", {}, WAIT);
}

async function fromPicker() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Compare versions" }, WAIT));
  return screen.findByRole("dialog", { name: "Compare versions" }, WAIT);
}

describe("opening, choosing and showing (ac-1)", () => {
  it("opens from the picker on the two newest; a dropdown swaps; Show moves the head only", async () => {
    const { t, b3 } = versionedThread();
    await opened(t);
    await fromPicker();
    await waitFor(() => expect(announcement()).toBe(COMPARING));
    const regions = within(must(dialog())).getAllByRole("region");
    expect(regions.map((r) => r.getAttribute("aria-label"))).toEqual(["Version 2", "Version 3"]);
    expect(column("Version 2").textContent).toContain("answer two");
    expect(column("Version 3").textContent).toContain("answer three");
    // Each column's dropdown lists the others: the left one offers Version 1 in its place.
    const user = userEvent.setup();
    const left = within(column("Version 2")).getByRole("combobox", {
      name: "Version in the left column",
    });
    expect(
      within(left)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Version 1", "Version 2"]);
    await user.selectOptions(left, "Version 1");
    expect(column("Version 1").textContent).toContain("answer one");
    expect(column("Version 3")).toBeTruthy();
    // Show this version: the head moves to that branch, the leaf stays, the dialog closes.
    await user.click(
      within(column("Version 1")).getByRole("button", { name: "Show this version" }),
    );
    await waitFor(() => expect(dialog()).toBeNull());
    expect(await screen.findByText("answer one", {}, WAIT)).toBeTruthy();
    expect(screen.queryByText("answer three")).toBeNull();
    expect(bar()).not.toBeNull();
    expect(leafPosts()).toEqual([]);
    expect(fake.threads.get(t)?.leaf_entry_id).toBe(b3);
  });

  it("opens from the tree's Compare with… and from the palette", async () => {
    const { t } = versionedThread();
    await opened(t);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Conversation tree/ }, WAIT));
    const panel = await screen.findByRole("dialog", { name: "Conversation tree" }, WAIT);
    // The picked node (Version 1) on the left, the newest other version on the right.
    const [row] = within(within(panel).getByRole("tree")).getAllByRole("treeitem", {
      name: /the question/,
    });
    await user.click(within(must(row)).getByRole("button", { name: /^Actions for/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Compare with…" }));
    expect(await screen.findByRole("dialog", { name: "Compare versions" }, WAIT)).toBeTruthy();
    expect(regionNames()).toEqual(["Version 1", "Version 3"]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog()).toBeNull());
    fireEvent.pointerOver(await screen.findByText("an edited question"));
    const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "k", code: "KeyK", ...mod });
    await screen.findByRole("dialog", { name: "Command palette" });
    await user.keyboard("compare versions{Enter}");
    expect(await screen.findByRole("dialog", { name: "Compare versions" }, WAIT)).toBeTruthy();
    // The focused (hovered) message is the one picked: Version 3, then the newest other.
    expect(regionNames()).toEqual(["Version 3", "Version 2"]);
  });

  it("works for a reader and on a test thread (CT19); a reader's Show moves only the head", async () => {
    const { t, b3 } = versionedThread({ readOnly: true });
    await opened(t);
    await fromPicker();
    const user = userEvent.setup();
    await user.click(
      within(column("Version 2")).getByRole("button", { name: "Show this version" }),
    );
    expect(await screen.findByText("two", { selector: "strong" }, WAIT)).toBeTruthy();
    expect(leafPosts()).toEqual([]);
    expect(fake.threads.get(t)?.leaf_entry_id).toBe(b3);
    cleanup();
    const test = versionedThread({ test: true });
    await opened(test.t);
    await fromPicker();
    expect(column("Version 3")).toBeTruthy();
  });
});

describe("the columns (ac-2)", () => {
  it("render read-only: Markdown, tool cards collapsed, Copy and feedback only", async () => {
    const { t } = versionedThread();
    await opened(t);
    await fromPicker();
    const user = userEvent.setup();
    await user.selectOptions(
      within(column("Version 2")).getByRole("combobox", { name: "Version in the left column" }),
      "Version 1",
    );
    const one = column("Version 1");
    // The tool card as the conversation shows it: collapsed.
    const card = within(one).getByRole("button", { name: /write/ });
    expect(card.getAttribute("aria-expanded")).toBe("false");
    await user.selectOptions(
      within(one).getByRole("combobox", { name: "Version in the left column" }),
      "Version 2",
    );
    const two = column("Version 2");
    expect(within(two).getByText("two", { selector: "strong" })).toBeTruthy();
    // Headed by model, tokens and time (the run's usage).
    const details = within(two).getByRole("group", { name: "Answer details" });
    expect(details.textContent).toContain("model-two");
    expect(details.textContent).toContain("202 in");
    expect(within(two).getByRole("button", { name: /Copy/ })).toBeTruthy();
    for (const name of [/Regenerate/, /Edit/, /Fork/, /Continue from here/]) {
      expect(within(two).queryByRole("button", { name })).toBeNull();
    }
    // The prompts differ (an edit): each column shows its own.
    expect(within(two).getByText("the question")).toBeTruthy();
    expect(within(column("Version 3")).getByText("an edited question")).toBeTruthy();
  });

  it("feedback is per column; full-screen under 820 px; Escape closes", async () => {
    const { t, runs } = versionedThread();
    await opened(t);
    await fromPicker();
    const user = userEvent.setup();
    const up = await within(column("Version 2")).findByRole(
      "button",
      { name: "Good answer" },
      WAIT,
    );
    await user.click(up);
    await waitFor(() => expect(up.getAttribute("aria-pressed")).toBe("true"));
    expect(fake.feedback.get(must(runs[1]))).toMatchObject({ rating: "up" });
    expect(fake.feedback.get(must(runs[2]))).toBeUndefined();
    const right = within(column("Version 3")).getByRole("button", { name: "Good answer" });
    expect(right.getAttribute("aria-pressed")).toBe("false");
    expect(must(dialog()).getAttribute("data-kobe-compare")).toBe("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog()).toBeNull());
    resizeWindow(390);
    await fromPicker();
    await waitFor(() => expect(must(dialog()).getAttribute("data-kobe-compare")).toBe("sheet"));
  });
});
