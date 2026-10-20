// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { chatRequests, composer, openApp, openRowMenu, threadGroup } from "./testing";

/**
 * KOBE-292 (ac-1): a thread row has no rename or Trash icons; its ⋯ button opens Copy,
 * Regenerate, Regenerate with (the models, as on answers) and Delete. Regenerate acts on the
 * thread's last answer through the same paths as the answer's own buttons, opening the thread.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push(
    { alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true },
    { alias: "glm", label: "GLM 5.3", enabled: true, is_default: false },
  );
  vi.stubGlobal("fetch", fake.fetch);
  vi.stubGlobal("ClipboardItem", undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const list = () => threadGroup("Your threads");
const say = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const messagePosts = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/messages"));

/** A thread with one answer, in two versions; the second is on screen. */
function answered(title: string) {
  const t = fake.addThread(title);
  const root = fake.addSystemEntry(t, null, "thinking_level_change", { thinkingLevel: "off" });
  const u1 = fake.addEntry(t, root, { role: "user", content: "summarise it" });
  fake.addEntry(t, u1, say("first version"));
  const u2 = fake.addEntry(t, root, { role: "user", content: "summarise it" });
  const a2 = fake.addEntry(t, u2, say("second version"));
  must(fake.threads.get(t)).leaf_entry_id = a2;
  return { t, root };
}

describe("thread row menu (KOBE-292)", () => {
  it("replaces the row's rename and Trash icons with one menu button", async () => {
    answered("Budget");
    openApp(fake);
    const items = within(await list());
    const button = await items.findByRole("button", { name: "Actions for Budget" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(items.queryByRole("button", { name: "Rename Budget" })).toBeNull();
    expect(items.queryByRole("button", { name: "Move Budget to Trash" })).toBeNull();
    const menu = await openRowMenu("Actions for Budget");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual([
      "Copy",
      "Regenerate",
      "Regenerate with",
      "Pin",
      "Move to project",
      "Archive",
      "Share",
      "Make a skill from this",
      "Save skill to Workbench",
      "Delete",
    ]);
  });

  it("Copy puts the branch on screen on the clipboard as Markdown, without opening it", async () => {
    answered("Budget");
    const other = fake.addThread("Other");
    openApp(fake, other);
    const user = userEvent.setup();
    const menu = await openRowMenu("Actions for Budget");
    await user.click(within(menu).getByRole("menuitem", { name: "Copy" }));
    expect(await screen.findByText("Copied “Budget” as Markdown.")).toBeTruthy();
    // user-event's clipboard stub stands in for the browser's.
    expect(await navigator.clipboard.readText()).toBe(
      "# Budget\n\n## You\n\nsummarise it\n\n## Assistant\n\nsecond version\n",
    );
    // Nothing opened: the Threads panel stays, and closes back onto the same thread.
    const panel = screen.getByRole("dialog", { name: "Threads" });
    await user.click(within(panel).getByRole("button", { name: "Close Threads" }));
    await waitFor(() => expect(window.location.search).toBe(`?thread=${other}`));
  });

  it("Regenerate opens the thread and regenerates its last answer from the same branch point", async () => {
    const { t, root } = answered("Budget");
    const other = fake.addThread("Other");
    openApp(fake, other);
    const user = userEvent.setup();
    const menu = await openRowMenu("Actions for Budget");
    await user.click(within(menu).getByRole("menuitem", { name: "Regenerate" }));
    await waitFor(() => expect(window.location.search).toBe(`?thread=${t}`));
    await waitFor(() => expect(messagePosts()).toHaveLength(1));
    expect(messagePosts()[0]).toMatchObject({
      path: `/v1/threads/${t}/messages`,
      body: { content: "summarise it", parent_entry_id: root },
    });
  });

  it("Regenerate with lists the team's models and switches the thread's model first", async () => {
    const { t, root } = answered("Budget");
    openApp(fake, t);
    await screen.findByText("second version");
    const user = userEvent.setup();
    const menu = await openRowMenu("Actions for Budget");
    // By keyboard: happy-dom has no layout for Radix's pointer grace area between the menus.
    within(menu).getByRole("menuitem", { name: "Regenerate with" }).focus();
    await user.keyboard("{ArrowRight}");
    const sub = await screen.findByRole("menu", { name: "Regenerate with" });
    expect(
      within(sub)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Team default (Kimi K2.7 Code) (current)", "Kimi K2.7 Code", "GLM 5.3"]);
    within(sub).getByRole("menuitem", { name: "GLM 5.3" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(messagePosts()).toHaveLength(1));
    expect(fake.threads.get(t)?.model).toBe("glm");
    expect(messagePosts()[0]?.body).toEqual({ content: "summarise it", parent_entry_id: root });
  });

  it("Regenerate is unavailable while a run is going, with the reason", async () => {
    const { t } = answered("Budget");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "more{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const menu = await openRowMenu("Actions for Budget");
    for (const name of ["Regenerate", "Regenerate with"]) {
      const item = within(menu).getByRole("menuitem", { name });
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.getAttribute("title")).toBe("Wait for the current run to finish.");
    }
    await user.click(within(menu).getByRole("menuitem", { name: "Regenerate" }));
    expect(messagePosts()).toHaveLength(1); // the "more" message only
  });

  it("Delete moves the thread to Trash at once: it can be restored, so nothing asks", async () => {
    const { t } = answered("Budget");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    openApp(fake);
    const user = userEvent.setup();
    await user.click(
      within(await openRowMenu("Actions for Budget")).getByRole("menuitem", { name: "Delete" }),
    );
    await waitFor(() => expect(fake.threads.get(t)?.deleted_at).not.toBeNull());
    expect(confirm).not.toHaveBeenCalled();
    expect(chatRequests(fake, "DELETE").at(-1)?.path).toBe(`/v1/threads/${t}`);
  });

  it("Delete is unavailable on a conversation shared with you read-only, with the reason", async () => {
    const { t } = answered("Budget");
    must(fake.threads.get(t)).read_only = true;
    openApp(fake);
    const user = userEvent.setup();
    const menu = await openRowMenu("Actions for Budget");
    const item = within(menu).getByRole("menuitem", { name: "Delete" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("title")).toBe(
      "This conversation is shared with you read-only: only its owner can delete it.",
    );
    await user.click(item);
    expect(chatRequests(fake, "DELETE")).toEqual([]);
  });

  it("a refused move to Trash is shown", async () => {
    const { t } = answered("Budget");
    fake.failNext.set(
      `DELETE /v1/threads/${t}`,
      Response.json(
        { code: "thread_busy", message: "Stop the run and clear the queue first." },
        { status: 409 },
      ),
    );
    openApp(fake);
    const user = userEvent.setup();
    await user.click(
      within(await openRowMenu("Actions for Budget")).getByRole("menuitem", { name: "Delete" }),
    );
    expect((await screen.findAllByText("Stop the run and clear the queue first."))[0]).toBeTruthy();
    expect(await screen.findByText("“Budget” could not be moved to Trash.")).toBeTruthy();
    expect(fake.threads.get(t)?.deleted_at).toBeNull();
  });

  it("Copy says it is partial when part of an answer can't be included", async () => {
    const t = fake.addThread("Long");
    const u1 = fake.addEntry(t, null, { role: "user", content: "write it all" });
    fake.addEntry(t, u1, say("a very long answer"), { offloaded: true });
    openApp(fake);
    const user = userEvent.setup();
    await user.click(
      within(await openRowMenu("Actions for Long")).getByRole("menuitem", { name: "Copy" }),
    );
    expect(await screen.findByText("Copied (partial)")).toBeTruthy();
    expect(await navigator.clipboard.readText()).toBe(
      "# Long\n\n## You\n\nwrite it all\n\n## Assistant\n\n[long answer not included]\n",
    );
  });
});
