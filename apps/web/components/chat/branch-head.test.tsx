// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { LEAF_BUSY_NOTE, OVER_WINDOW_NOTE } from "./branch-bar";
import { announcement, chatRequests, composer, openApp, openThreads, streaming } from "./testing";

/** The local head in the app (CT3, CT13, CT15; KOBE-544): picker, bar, send, search hit. */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };
let scrolled: Element[];

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
  scrolled = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this);
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Like Pi 1.0: a settings entry at the root, then two versions of the second question. */
function branchedThread(readOnly = false) {
  const t = fake.addThread("Branches");
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
  if (readOnly) {
    Object.assign(must(fake.threads.get(t)), {
      read_only: true,
      visibility: "team",
      owner_name: "Ann",
    });
  }
  return { t, u2, a2, u2b, a2b };
}

const leafPosts = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/leaf"));
const bar = () => screen.queryByRole("region", { name: "Another branch" });
const previous = () => must(screen.getAllByRole("button", { name: "Previous version" })[0]);

/** Opens the thread from a search hit in the Threads panel. */
async function openHit(query: string, title: string) {
  openApp(fake);
  await composer();
  const user = userEvent.setup();
  const dialog = await openThreads();
  await user.type(within(dialog).getByLabelText("Search threads"), query);
  const hits = within(await within(dialog).findByRole("list", { name: "Search results" }, WAIT));
  await user.click(await hits.findByRole("button", { name: title }, WAIT));
  return user;
}

describe("the branch picker (ac-1)", () => {
  it("a reader's arrows move only the head: the leaf route is never called", async () => {
    const { t, a2b } = branchedThread(true);
    openApp(fake, t);
    expect(await screen.findByText("new answer", {}, WAIT)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(previous());
    expect(await screen.findByText("old answer")).toBeTruthy();
    expect(screen.queryByText("new answer")).toBeNull();
    const shown = must(bar());
    expect(shown.textContent).toContain("Showing another branch");
    expect(shown.textContent).toContain("2 messages differ");
    // Readers write nothing: no Make it current.
    expect(within(shown).queryByRole("button", { name: "Make it current" })).toBeNull();
    await waitFor(() => expect(announcement()).toBe("Showing another branch"));
    expect(leafPosts()).toEqual([]);
    expect(fake.threads.get(t)?.leaf_entry_id).toBe(a2b);
    // ✕ returns to the leaf, from the keyboard too.
    within(shown).getByRole("button", { name: "Back to the current branch" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("new answer")).toBeTruthy();
    expect(bar()).toBeNull();
    expect(leafPosts()).toEqual([]);
  });

  it("the owner's arrows still move the leaf, with no bar", async () => {
    const { t, a2 } = branchedThread();
    openApp(fake, t);
    await screen.findByText("new answer", {}, WAIT);
    await userEvent.setup().click(previous());
    expect(await screen.findByText("old answer")).toBeTruthy();
    await waitFor(() => expect(leafPosts().map((r) => r.body)).toEqual([{ entry_id: a2 }]));
    expect(bar()).toBeNull();
  });
});

describe("a search hit on another branch (ac-4) and the bar (ac-2)", () => {
  it("opens on the hit's branch, scrolled to it, with the bar; the leaf is untouched", async () => {
    const { t, a2b } = branchedThread();
    await openHit("old question", "Branches");
    expect(await screen.findByText("old answer", {}, WAIT)).toBeTruthy();
    expect(screen.queryByText("new answer")).toBeNull();
    expect(must(bar()).textContent).toContain("2 messages differ");
    await waitFor(() =>
      expect(scrolled.some((el) => el.textContent?.includes("old question"))).toBe(true),
    );
    expect(leafPosts()).toEqual([]);
    expect(fake.threads.get(t)?.leaf_entry_id).toBe(a2b);
    // The hit's note in the panel says where it matched.
    const dialog = await openThreads();
    await userEvent.setup().type(within(dialog).getByLabelText("Search threads"), "old question");
    expect(await within(dialog).findByText("on another branch", {}, WAIT)).toBeTruthy();
  });

  it("Make it current posts the leaf once and the bar goes", async () => {
    const { t, a2 } = branchedThread();
    const user = await openHit("old question", "Branches");
    const shown = await screen.findByRole("region", { name: "Another branch" }, WAIT);
    await user.click(within(shown).getByRole("button", { name: "Make it current" }));
    await waitFor(() => expect(bar()).toBeNull());
    expect(leafPosts().map((r) => r.body)).toEqual([{ entry_id: a2 }]);
    expect(fake.threads.get(t)?.leaf_entry_id).toBe(a2);
    expect(screen.getByText("old answer")).toBeTruthy();
    await waitFor(() => expect(announcement()).toBe("This branch is now current"));
  });

  it("under a queued run Make it current shows the queued note and never retries", async () => {
    const { t, a2b } = branchedThread();
    fake.queueRetry(t, "waiting");
    const user = await openHit("old question", "Branches");
    const shown = await screen.findByRole("region", { name: "Another branch" }, WAIT);
    await user.click(within(shown).getByRole("button", { name: "Make it current" }));
    expect(await within(shown).findByText(LEAF_BUSY_NOTE)).toBeTruthy();
    expect(leafPosts()).toHaveLength(1);
    expect(bar()).not.toBeNull();
    expect(fake.threads.get(t)?.leaf_entry_id).toBe(a2b);
  });

  it("a branch over the model's window warns before Make it current, which proceeds (CT16)", async () => {
    fake.teamModels.push({
      alias: "small",
      label: "Small",
      enabled: true,
      is_default: true,
      context_window: 100_000,
    });
    const t = fake.addThread("Long");
    const u1 = fake.addEntry(t, null, { role: "user", content: "start" });
    const big = fake.addEntry(t, u1, {
      role: "assistant",
      content: [{ type: "text", text: "big branch" }],
      usage: { input: 150_000, cacheRead: 0, cacheWrite: 0 },
    });
    fake.addEntry(t, null, { role: "user", content: "fresh start" });
    const user = await openHit("big branch", "Long");
    const shown = await screen.findByRole("region", { name: "Another branch" }, WAIT);
    expect(await within(shown).findByText(OVER_WINDOW_NOTE, {}, WAIT)).toBeTruthy();
    await user.click(within(shown).getByRole("button", { name: "Make it current" }));
    await waitFor(() => expect(leafPosts().map((r) => r.body)).toEqual([{ entry_id: big }]));
  });

  it("on a scheduled thread the bar says the schedule continues on this branch", async () => {
    const { t } = branchedThread();
    fake.setScheduleId(t, "s1");
    await openHit("old question", "Branches");
    const shown = await screen.findByRole("region", { name: "Another branch" }, WAIT);
    expect(within(shown).getByText("The schedule will continue on this branch.")).toBeTruthy();
  });
});

describe("sending from a browsed branch (ac-3)", () => {
  it("continues the head's last entry and the head follows the new leaf", async () => {
    const { t, a2 } = branchedThread();
    const user = await openHit("old question", "Branches");
    await screen.findByRole("region", { name: "Another branch" }, WAIT);
    expect(screen.getByText("Sending here makes this branch current")).toBeTruthy();
    await user.type(await composer(), "go on here{Enter}");
    await waitFor(() =>
      expect(chatRequests(fake, "POST").find((r) => r.path.endsWith("/messages"))?.body).toEqual({
        content: "go on here",
        parent_entry_id: a2,
      }),
    );
    expect(bar()).toBeNull();
    const run = fake.latestRun(t);
    await streaming(fake, run.run_id);
    fake.agent.commitPrompt(run.run_id);
    const answer = fake.agent.commit(run.run_id, {
      role: "assistant",
      content: [{ type: "text", text: "here it is" }],
    });
    fake.agent.complete(run.run_id);
    expect(await screen.findByText("here it is", {}, WAIT)).toBeTruthy();
    expect(screen.getByText("old answer")).toBeTruthy();
    expect(fake.threads.get(t)?.leaf_entry_id).toBe(answer);
    expect(bar()).toBeNull();
    expect(leafPosts()).toEqual([]);
  });
});

describe("the leaf on the wire (ac-5)", () => {
  it("a reader sees the owner's leaf move live; a browsing reader keeps the branch", async () => {
    const { t, a2, u2b, a2b } = branchedThread(true);
    const run = fake.queueRetry(t, "waiting");
    openApp(fake, t);
    await screen.findByText("new answer", {}, WAIT);
    await streaming(fake, run);
    fake.agent.leafMoved(run, a2);
    expect(await screen.findByText("old answer", {}, WAIT)).toBeTruthy();
    expect(screen.queryByText("new answer")).toBeNull();
    expect(bar()).toBeNull();
    // Browsing the other version, the next move elsewhere leaves this tab where it is.
    await userEvent.setup().click(must(screen.getAllByRole("button", { name: "Next version" })[0]));
    expect(await screen.findByText("new answer")).toBeTruthy();
    expect(bar()).not.toBeNull();
    // The leaf moves up this branch: the head stays, the bar's count follows.
    fake.agent.leafMoved(run, u2b);
    await waitFor(() => expect(must(bar()).textContent).toContain("1 message differs"));
    expect(screen.getByText("new answer")).toBeTruthy();
    // ... until the leaf comes to it.
    fake.agent.leafMoved(run, a2b);
    await waitFor(() => expect(bar()).toBeNull());
    expect(leafPosts()).toEqual([]);
  });
});
