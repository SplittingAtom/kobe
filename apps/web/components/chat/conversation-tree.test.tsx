// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMacPlatform } from "../../lib/shell/shortcuts";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { EMPTY_TREE_NOTE, FILES_LEFT_NOTE, TREE_HELP_TEXT } from "../../lib/chat/tree-panel";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { ChatApp } from "./chat-app";
import { announcement, chatRequests, composer, openApp } from "./testing";

/** KOBE-546 (CT4, CT8, CT9, CT12, CT18, CT19): the Conversation tree panel in the app. */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };
let scrolled: Element[];

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
  resizeWindow(DESKTOP_WIDTH);
  scrolled = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this);
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Pi's settings entry, then two versions of the second question; the leaf on the newer. */
function branchedThread(options: { readOnly?: boolean; test?: boolean } = {}) {
  const t = fake.addThread("Budget 2027");
  const root = fake.addSystemEntry(t, null, "thinking_level_change", { thinkingLevel: "off" });
  const u1 = fake.addEntry(t, root, { role: "user", content: "start" });
  const a1 = fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "a1" }] });
  const u2 = fake.addEntry(t, a1, { role: "user", content: "old question" });
  const step = fake.addEntry(t, u2, {
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
  const a2 = fake.addEntry(t, result, {
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
  return { t, u1, a1, u2, a2, u2b, a2b };
}

const panel = () => screen.queryByRole("dialog", { name: "Conversation tree" });
const tree = () => within(must(panel())).getByRole("tree");
const row = (text: string | RegExp) =>
  within(tree()).getByRole("treeitem", {
    name: typeof text === "string" ? new RegExp(text) : text,
  });
const bar = () => screen.queryByRole("region", { name: "Another branch" });
const leafPosts = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/leaf"));
const writes = () =>
  fake.requests.filter((r) => r.method !== "GET" && r.path.startsWith("/v1/threads"));

async function openTree() {
  const button = await screen.findByRole("button", { name: /^Conversation tree/ }, WAIT);
  await userEvent.setup().click(button);
  return screen.findByRole("dialog", { name: "Conversation tree" }, WAIT);
}

async function opened(t: string) {
  openApp(fake, t);
  await screen.findByText("new answer", {}, WAIT);
}

async function menuOf(text: string) {
  const r = row(text);
  await userEvent.setup().click(within(r).getByRole("button", { name: /^Actions for/ }));
  return screen.findByRole("menu");
}

describe("opening and closing (ac-1)", () => {
  it("opens from the header button at /tree with the junction badge; Escape returns", async () => {
    const { t } = branchedThread();
    await opened(t);
    const button = screen.getByRole("button", { name: "Conversation tree, 1 branch" });
    expect(button.textContent).toContain("Tree");
    await openTree();
    expect(window.location.pathname).toBe("/tree");
    const dialog = must(panel());
    expect(within(dialog).getByText("Budget 2027")).toBeTruthy();
    expect(within(dialog).getByText("1 branch · 0 forks")).toBeTruthy();
    expect(within(dialog).getByText(TREE_HELP_TEXT)).toBeTruthy();
    // The conversation stays mounted under it.
    expect(must(document.querySelector("[data-kobe-thread-root]")).textContent).toContain(
      "new answer",
    );
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(panel()).toBeNull());
    expect(window.location.pathname).toBe("/");
  });

  it("Close and Back close it; a reload at /tree keeps it open", async () => {
    const { t } = branchedThread();
    await opened(t);
    await openTree();
    await userEvent.setup().click(screen.getByRole("button", { name: "Close Conversation tree" }));
    await waitFor(() => expect(panel()).toBeNull());
    await openTree();
    act(() => {
      window.history.back();
    });
    await waitFor(() => expect(panel()).toBeNull(), WAIT);
    // A reload at /tree: the workspace reopens its last thread with the panel over it.
    cleanup();
    window.history.replaceState(null, "", "/tree");
    render(<ChatApp fetchFn={fake.fetch} eventSource={fake.eventSource} reopenDelayMs={() => 0} />);
    expect(await screen.findByRole("dialog", { name: "Conversation tree" }, WAIT)).toBeTruthy();
    expect(await within(tree()).findByRole("treeitem", { name: /new answer/ }, WAIT)).toBeTruthy();
  });

  it("clicking a node off screen shows its branch (head only), closes and scrolls to it", async () => {
    const { t, a2b } = branchedThread();
    await opened(t);
    await openTree();
    await userEvent.setup().click(row("old question"));
    await waitFor(() => expect(panel()).toBeNull());
    expect(await screen.findByText("old answer", {}, WAIT)).toBeTruthy();
    expect(screen.queryByText("new answer")).toBeNull();
    expect(bar()).not.toBeNull();
    // CT6: the leaf's branch left nothing behind, so the bar has no files line.
    expect(must(bar()).textContent).not.toContain(FILES_LEFT_NOTE);
    await waitFor(() =>
      expect(scrolled.some((el) => el.textContent?.includes("old question"))).toBe(true),
    );
    expect(leafPosts()).toEqual([]);
    expect(fake.threads.get(t)?.leaf_entry_id).toBe(a2b);
  });

  it("opens from the ForkMarker link, the bar's Tree and the palette; never on a draft", async () => {
    const { t } = branchedThread();
    await opened(t);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Forked here · 2 branches/ }));
    expect(await screen.findByRole("dialog", { name: "Conversation tree" }, WAIT)).toBeTruthy();
    await user.click(row("old question"));
    await waitFor(() => expect(panel()).toBeNull());
    await user.click(within(must(bar())).getByRole("button", { name: "Tree" }));
    expect(await screen.findByRole("dialog", { name: "Conversation tree" }, WAIT)).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(panel()).toBeNull());
    const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "k", code: "KeyK", ...mod });
    await screen.findByRole("dialog", { name: "Command palette" });
    await user.keyboard("conversation tree{Enter}");
    expect(await screen.findByRole("dialog", { name: "Conversation tree" }, WAIT)).toBeTruthy();
    cleanup();
    openApp(fake);
    await composer();
    expect(screen.queryByRole("button", { name: /^Conversation tree/ })).toBeNull();
  });

  it("a straight thread opens with the empty note", async () => {
    const t = fake.addThread("Straight");
    const u = fake.addEntry(t, null, { role: "user", content: "hello" });
    fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "hi there" }] });
    openApp(fake, t);
    await screen.findByText("hi there", {}, WAIT);
    const dialog = await openTree();
    expect(within(dialog).getByText(EMPTY_TREE_NOTE)).toBeTruthy();
    expect(within(dialog).getByText("0 branches · 0 forks")).toBeTruthy();
  });

  it("draws a fork as a link row off its node", async () => {
    const { t, a1 } = branchedThread();
    const f = fake.addThread("Budget 2027 — marketing cut");
    Object.assign(must(fake.threads.get(f)), { forked_from_thread_id: t, forked_at_entry_id: a1 });
    await opened(t);
    const dialog = await openTree();
    expect(within(dialog).getByText("1 branch · 1 fork")).toBeTruthy();
    const fork = within(tree()).getByRole("treeitem", {
      name: "Fork, Budget 2027 — marketing cut",
    });
    await userEvent.setup().click(fork);
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("thread")).toBe(f));
    await waitFor(() => expect(panel()).toBeNull());
  });
});

describe("Continue from here (ac-2)", () => {
  it("dims what follows, sets the chip, and the send carries the answer's last entry", async () => {
    const { t, a1 } = branchedThread();
    await opened(t);
    const user = userEvent.setup();
    const answers = screen.getAllByRole("button", { name: "Continue from here" });
    // a1 only: never on the leaf's own last answer.
    expect(answers).toHaveLength(1);
    await user.click(must(answers[0]));
    const chip = await screen.findByText(/Continuing from the answer at “a1”/);
    expect(chip).toBeTruthy();
    const dimmed = [...document.querySelectorAll("[data-kobe-dimmed]")].map((e) => e.textContent);
    expect(dimmed.some((x) => x?.includes("new question"))).toBe(true);
    expect(dimmed.some((x) => x?.includes("new answer"))).toBe(true);
    expect(screen.getByText("new answer")).toBeTruthy();
    expect(writes().map((r) => r.path)).toEqual([]);
    const input = await composer();
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText(/Continuing from the answer/)).toBeNull());
    expect(document.querySelectorAll("[data-kobe-dimmed]")).toHaveLength(0);
    await user.click(must(screen.getAllByRole("button", { name: "Continue from here" })[0]));
    await screen.findByText(/Continuing from the answer/);
    await user.type(input, "another way{Enter}");
    await waitFor(() => {
      const post = chatRequests(fake, "POST").find((r) => r.path.endsWith("/messages"));
      expect(post?.body).toMatchObject({ content: "another way", parent_entry_id: a1 });
    });
    await waitFor(() => expect(screen.queryByText(/Continuing from the answer/)).toBeNull());
  });

  it("from the tree's menu: the panel closes onto the chip", async () => {
    const { t } = branchedThread();
    await opened(t);
    await openTree();
    const menu = await menuOf("old answer");
    await userEvent
      .setup()
      .click(within(menu).getByRole("menuitem", { name: "Continue from here" }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(await screen.findByText(/Continuing from the answer at “old answer”/)).toBeTruthy();
    expect(screen.getByText("old answer")).toBeTruthy();
  });
});

describe("labels (ac-3)", () => {
  it("the owner sets and removes a label; the tree, the filter and the picker show it", async () => {
    const { t, u2b } = branchedThread();
    await opened(t);
    await openTree();
    const user = userEvent.setup();
    await user.click(
      within(await menuOf("new question")).getByRole("menuitem", { name: "Label…" }),
    );
    const field = await screen.findByRole("textbox", { name: "Label" });
    await user.type(field, "  try 5% cut  {Enter}");
    await waitFor(() =>
      expect(fake.labelWrites).toEqual([{ threadId: t, entryId: u2b, label: "try 5% cut" }]),
    );
    expect(await within(tree()).findByText("try 5% cut")).toBeTruthy();
    await waitFor(() => expect(announcement()).toBe("Label saved"));
    // The filter dims every node whose text or label does not match.
    await user.type(
      within(must(panel())).getByRole("searchbox", { name: "Filter the tree" }),
      "5%",
    );
    expect(row("new question").getAttribute("data-dimmed")).toBeNull();
    expect(row("old question").getAttribute("data-dimmed")).toBe("true");
    await user.clear(within(must(panel())).getByRole("searchbox", { name: "Filter the tree" }));
    await user.click(
      within(await menuOf("new question")).getByRole("menuitem", { name: "Remove label" }),
    );
    await waitFor(() => expect(fake.labelWrites.at(-1)?.label).toBeNull());
    await waitFor(() => expect(within(tree()).queryByText("try 5% cut")).toBeNull());
  });

  it("the picker shows the label of a branch's first message", async () => {
    const { t, u2b } = branchedThread();
    fake.branches.set(t, { labels: [{ entry_id: u2b, label: "try 5% cut" }], runs: [] });
    await opened(t);
    await waitFor(() => expect(screen.getAllByText(/· try 5% cut/).length).toBeGreaterThan(0));
    expect(document.body.textContent).toContain("Version 2 of 2 · try 5% cut");
  });

  it("a reader sees labels and cannot edit them", async () => {
    const { t, u2b } = branchedThread({ readOnly: true });
    fake.branches.set(t, { labels: [{ entry_id: u2b, label: "keeper" }], runs: [] });
    await opened(t);
    await openTree();
    expect(await within(tree()).findByText("keeper")).toBeTruthy();
    const menu = await menuOf("new question");
    expect(within(menu).queryByRole("menuitem", { name: "Label…" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Make it current" })).toBeNull();
  });

  it("test threads: no Label, the route refuses; the tree and Continue from here work", async () => {
    const { t, u2b } = branchedThread({ test: true });
    await opened(t);
    await openTree();
    const menu = await menuOf("old answer");
    expect(within(menu).queryByRole("menuitem", { name: "Label…" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Continue from here" })).toBeTruthy();
    const res = await fake.fetch(`/v1/threads/${t}/labels/${u2b}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-kobe-team": fake.teamId },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("test_thread");
  });
});

describe("keyboard and accessibility (ac-4)", () => {
  it("rows are a role=tree; arrows, Home/End, Enter, / and the context-menu key", async () => {
    const { t } = branchedThread();
    await opened(t);
    const dialog = await openTree();
    const svg = must(dialog.querySelector("svg[data-kobe-tree-graph]"));
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    const onScreen = row("new answer");
    expect(onScreen.getAttribute("aria-current")).toBe("true");
    expect(onScreen.getAttribute("aria-level")).toBe("1");
    expect(row("old question").getAttribute("aria-level")).toBe("2");
    expect(row("old answer").getAttribute("aria-label")).toMatch(
      /^Agent, old answer, .*1 file changed$/,
    );
    expect(onScreen.textContent).toContain("◀ on screen");
    expect(onScreen.textContent).toContain("leaf");
    const user = userEvent.setup();
    onScreen.focus();
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(row(/^You, start/));
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(row("old question"));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(row("new question"));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(row("old question"));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(row("new answer"));
    await user.keyboard("/");
    expect(document.activeElement).toBe(
      within(dialog).getByRole("searchbox", { name: "Filter the tree" }),
    );
    row("old question").focus();
    fireEvent.keyDown(row("old question"), { key: "ContextMenu" });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Show in conversation" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Make it current" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Edit this message" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Compare with…" })).toBeNull();
    await user.keyboard("{Escape}");
    row("old question").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(panel()).toBeNull());
    expect(await screen.findByText("old answer", {}, WAIT)).toBeTruthy();
  });

  it("Make it current from the menu warns about files left changed, then posts the leaf", async () => {
    const { t, a2b } = branchedThread();
    // The leaf on the branch that wrote plan.md; making the other one current leaves it behind.
    must(fake.threads.get(t)).leaf_entry_id = must(fake.threads.get(t)).entries.find((e) =>
      JSON.stringify(e.payload).includes("old answer"),
    )?.entry_id as string;
    openApp(fake, t);
    await screen.findByText("old answer", {}, WAIT);
    await openTree();
    const user = userEvent.setup();
    await user.click(
      within(await menuOf("new answer")).getByRole("menuitem", { name: "Make it current" }),
    );
    const group = await screen.findByRole("group", { name: "Make it current" });
    expect(group.textContent).toContain(FILES_LEFT_NOTE);
    await user.click(within(group).getByRole("button", { name: "Make it current" }));
    await waitFor(() => expect(leafPosts().map((r) => r.body)).toEqual([{ entry_id: a2b }]));
    await waitFor(() => expect(panel()).toBeNull());
  });

  it("Edit this message closes the tree onto the message's editor", async () => {
    const { t } = branchedThread();
    await opened(t);
    await openTree();
    await userEvent
      .setup()
      .click(
        within(await menuOf("old question")).getByRole("menuitem", { name: "Edit this message" }),
      );
    await waitFor(() => expect(panel()).toBeNull());
    const editor = await screen.findByDisplayValue("old question", {}, WAIT);
    expect(editor.tagName).toBe("TEXTAREA");
  });
});

describe("narrow windows (ac-5)", () => {
  it("lists branches by junction with the chips and the node menu", async () => {
    resizeWindow(390);
    const { t } = branchedThread();
    await opened(t);
    const dialog = await openTree();
    expect(dialog.querySelector("[data-kobe-tree-panel='list']")).not.toBeNull();
    const section = within(dialog).getByRole("region", { name: "Branches after: a1" });
    const rows = within(section).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("old question"),
      expect.stringContaining("new question"),
    ]);
    expect(rows[0]?.textContent).toContain("📄 1 file");
    expect(rows[1]?.textContent).toContain("◀ on screen");
    expect(rows[1]?.textContent).toContain("leaf");
    const user = userEvent.setup();
    await user.click(within(must(rows[0])).getByRole("button", { name: /^Actions for/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Make it current" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(within(must(rows[0])).getByRole("button", { name: /^You, old question/ }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(await screen.findByText("old answer", {}, WAIT)).toBeTruthy();
  });

  it("a thread without junctions shows the empty note", async () => {
    resizeWindow(390);
    const t = fake.addThread("Straight");
    const u = fake.addEntry(t, null, { role: "user", content: "hello" });
    fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "hi there" }] });
    openApp(fake, t);
    await screen.findByText("hi there", {}, WAIT);
    const dialog = await openTree();
    expect(within(dialog).getByText(EMPTY_TREE_NOTE)).toBeTruthy();
  });
});
