// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRANCH_SUMMARY_ERROR_MESSAGES } from "@kobe/protocol";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { SUMMARY_TEXT } from "../../lib/chat/tree-panel";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { carryText } from "./branch-summary-dialog";
import { announcement, chatRequests, openApp } from "./testing";

/**
 * Make it current and carry a summary in the app (KOBE-548, CT11): the tree's node menu and the
 * bar's "Make it current ▾" open the dialog; Go posts the branch summary; the summary is the leaf,
 * shown folded as "Summary of another branch" on the branch entered and as the tree's summary row.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
  resizeWindow(DESKTOP_WIDTH);
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Two versions of the second question; the leaf on the newer one. */
function branchedThread(options: { readOnly?: boolean; test?: boolean } = {}) {
  const t = fake.addThread("Colours");
  const root = fake.addSystemEntry(t, null, "thinking_level_change", { thinkingLevel: "off" });
  const u1 = fake.addEntry(t, root, { role: "user", content: "start" });
  const a1 = fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "a1" }] });
  const u2 = fake.addEntry(t, a1, { role: "user", content: "old question" });
  const a2 = fake.addEntry(t, u2, {
    role: "assistant",
    content: [{ type: "text", text: "old answer" }],
  });
  const u2b = fake.addEntry(t, a1, { role: "user", content: "new question" });
  const a2b = fake.addEntry(t, u2b, {
    role: "assistant",
    content: [{ type: "text", text: "new answer" }],
  });
  const thread = must(fake.threads.get(t));
  if (options.readOnly) {
    Object.assign(thread, { read_only: true, visibility: "team", owner_name: "Ann" });
  }
  if (options.test) thread.is_test = true;
  return { t, a1, u2, a2, u2b, a2b };
}

const panel = () => screen.queryByRole("dialog", { name: "Conversation tree" });
const tree = () => within(must(panel())).getByRole("tree");
const row = (text: string) => within(tree()).getByRole("treeitem", { name: new RegExp(text) });
const summaryPosts = () =>
  chatRequests(fake, "POST").filter((r) => r.path.endsWith("/branch-summary"));
const carryDialog = () =>
  screen.findByRole("dialog", { name: "Make it current and carry a summary" }, WAIT);

async function opened(t: string) {
  openApp(fake, t);
  await screen.findByText("new answer", {}, WAIT);
}

async function openTree() {
  const button = await screen.findByRole("button", { name: /^Conversation tree/ }, WAIT);
  await userEvent.setup().click(button);
  return screen.findByRole("dialog", { name: "Conversation tree" }, WAIT);
}

async function menuOf(text: string) {
  await userEvent.setup().click(within(row(text)).getByRole("button", { name: /^Actions for/ }));
  return screen.findByRole("menu");
}

describe("from the tree's node menu (ac-3)", () => {
  it("summarises the branch left into the chosen one: marker, leaf, summary row, announcement", async () => {
    const { t, a2 } = branchedThread();
    await opened(t);
    await openTree();
    const user = userEvent.setup();
    const menu = await menuOf("old answer");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Make it current and carry a summary" }),
    );
    const dialog = await carryDialog();
    // One message pair is left behind: the newer question and its answer.
    expect(dialog.textContent).toContain(carryText(2));
    await user.type(within(dialog).getByRole("textbox"), "keep the colour");
    await user.click(within(dialog).getByRole("button", { name: "Go" }));
    await waitFor(() =>
      expect(summaryPosts().map((r) => r.body)).toEqual([
        { to_entry_id: a2, focus: "keep the colour" },
      ]),
    );
    await waitFor(() => expect(announcement()).toBe("This branch is now current"));
    const leaf = must(fake.threads.get(t)).leaf_entry_id;
    expect(leaf).toMatch(/^kb-/);
    // The conversation shows the entered branch with the folded summary.
    expect(await screen.findByText("old answer", {}, WAIT)).toBeTruthy();
    expect(screen.queryByText("new answer")).toBeNull();
    const marker = must(document.querySelector<HTMLElement>('[data-kobe-marker="branch_summary"]'));
    expect(within(marker).getByRole("button", { name: /Summary of another branch/ })).toBeTruthy();
    // The tree shows the summary row under the node it entered.
    await openTree();
    await waitFor(() => expect(row("old answer").textContent).toContain(SUMMARY_TEXT));
  });

  it("shows the server's fixed message when refused", async () => {
    const { t, a2b } = branchedThread();
    // Twenty summaries already (under the root, off every branch shown); the leaf stays.
    for (let i = 0; i < 20; i++) fake.addSystemEntry(t, null, "branch_summary", { summary: "s" });
    must(fake.threads.get(t)).leaf_entry_id = a2b;
    await opened(t);
    await openTree();
    const user = userEvent.setup();
    await user.click(
      within(await menuOf("old answer")).getByRole("menuitem", {
        name: "Make it current and carry a summary",
      }),
    );
    const dialog = await carryDialog();
    await user.click(within(dialog).getByRole("button", { name: "Go" }));
    expect(
      await within(dialog).findByText(BRANCH_SUMMARY_ERROR_MESSAGES.summary_limit, {}, WAIT),
    ).toBeTruthy();
  });

  it("is not offered to a reader, on a test thread, or on the leaf's own branch", async () => {
    for (const options of [{ readOnly: true }, { test: true }]) {
      const { t } = branchedThread(options);
      await opened(t);
      await openTree();
      const menu = await menuOf("old answer");
      expect(
        within(menu).queryByRole("menuitem", { name: "Make it current and carry a summary" }),
      ).toBeNull();
      cleanup();
    }
    const { t } = branchedThread();
    await opened(t);
    await openTree();
    const menu = await menuOf("new answer");
    expect(
      within(menu).queryByRole("menuitem", { name: "Make it current and carry a summary" }),
    ).toBeNull();
  });
});

describe("from the bar's Make it current ▾ (ac-3)", () => {
  it("carries a summary into the branch shown", async () => {
    const { t, a2 } = branchedThread();
    await opened(t);
    const user = userEvent.setup();
    // The owner's arrows move the leaf (KOBE-544): browse from the tree instead.
    await openTree();
    await user.click(
      within(await menuOf("old answer")).getByRole("menuitem", { name: "Show in conversation" }),
    );
    const bar = await screen.findByRole("region", { name: "Another branch" }, WAIT);
    await user.click(within(bar).getByRole("button", { name: "More ways to make it current" }));
    await user.click(await screen.findByRole("menuitem", { name: "and carry a summary" }));
    const dialog = await carryDialog();
    await user.click(within(dialog).getByRole("button", { name: "Go" }));
    await waitFor(() => expect(summaryPosts().map((r) => r.body)).toEqual([{ to_entry_id: a2 }]));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Another branch" })).toBeNull(),
    );
    expect(document.querySelector('[data-kobe-marker="branch_summary"]')).not.toBeNull();
  });
});
