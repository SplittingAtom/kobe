// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import {
  announcement,
  chatRequests,
  composer,
  crushedIconButtons,
  openApp,
  openRowMenu,
  streamed,
  streaming,
  openThreads,
  closeThreads,
  threadGroup,
} from "./testing";
import { must } from "../../lib/testing/must";

let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear(); // resume points are per tab; each test is a fresh tab
  localStorage.clear(); // a closed retention notice is remembered per browser
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const list = () => threadGroup("Your threads");

/** Delete in a thread row's ⋯ menu (KOBE-292): moves it to Trash. */
async function trashFromMenu(user: ReturnType<typeof userEvent.setup>, title: string) {
  const menu = await openRowMenu(`Actions for ${title}`);
  await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
}

describe("thread list (RemoteThreadListAdapter)", () => {
  it("lists the caller's threads newest first and opens one", async () => {
    fake.addThread("Older");
    const newer = fake.addThread("Newer");
    fake.addEntry(newer, null, { role: "user", content: "hello from newer" });
    openApp(fake);
    const items = within(await list());
    await waitFor(() => expect(items.getAllByRole("listitem")).toHaveLength(2));
    expect(items.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Newer"),
      expect.stringContaining("Older"),
    ]);
    await userEvent.setup().click(items.getByRole("button", { name: "Newer" }));
    // In the conversation: the pointer stays on the row it clicked, so the rail's hover card
    // (which shows the thread's first message) opens after its delay on a slow run (KOBE-415).
    expect(await within(screen.getByRole("main")).findByText("hello from newer")).toBeTruthy();
    expect(window.location.search).toBe(`?thread=${newer}`);
  });

  it("creates a thread on the first message, shown by its first line until the server titles it", async () => {
    openApp(fake);
    const user = userEvent.setup();
    await openThreads();
    await screen.findByText("No threads yet.");
    await user.type(
      await composer(),
      "Plot revenue by month{Shift>}{Enter}{/Shift}in a bar chart{Enter}",
    );
    await waitFor(() => expect(fake.threads.size).toBe(1));
    const [thread] = [...fake.threads.values()];
    expect(thread?.title).toBeNull(); // KOBE-219: the server titles it after the first answer
    const run = await waitFor(() => {
      const r = fake.activeRun(must(thread).thread_id);
      expect(r).toBeDefined();
      return must(r);
    });
    expect(run.input).toBe("Plot revenue by month\nin a bar chart");
    await streaming(fake, run.run_id);
    expect(screen.getByText(/Plot revenue by month/, { selector: "span" })).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(`?thread=${must(thread).thread_id}`));
    expect(
      within(await list()).getByRole("button", { name: "Plot revenue by month" }),
    ).toBeTruthy();
  });

  it("shows the server's title in the rail and the bar as soon as it arrives (KOBE-219 ac-2)", async () => {
    openApp(fake);
    const user = userEvent.setup();
    await openThreads();
    await screen.findByText("No threads yet.");
    await user.type(await composer(), "What drives revenue?{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    const [thread] = [...fake.threads.values()];
    const run = await waitFor(() => must(fake.activeRun(must(thread).thread_id)));
    await streaming(fake, run.run_id);
    expect(
      await within(await list()).findByRole("button", { name: "What drives revenue?" }),
    ).toBeTruthy();
    fake.agent.commitPrompt(run.run_id);
    fake.agent.complete(run.run_id, { epilogue: ["title"] });
    fake.agent.retitle(run.run_id, "Revenue drivers");
    expect(
      await within(await list()).findByRole("button", { name: "Revenue drivers" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.getElementById("kobe-thread-title")?.textContent).toBe("Revenue drivers"),
    );
    // No rename was sent: the title stays unlocked on the server.
    expect(chatRequests(fake, "PATCH")).toEqual([]);
  });

  it("shows a thread's card on hover: first message, agent, last activity, message count (KOBE-219 ac-3)", async () => {
    const t = fake.addThread("Budget review");
    const u = fake.addEntry(t, null, { role: "user", content: "Where did the Q3 budget go?" });
    fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "Mostly travel." }] });
    openApp(fake);
    const user = userEvent.setup();
    const row = await within(await list()).findByRole("button", { name: "Budget review" });
    await user.hover(row);
    const card = await screen.findByTestId("thread-card", {}, { timeout: 3_000 });
    await waitFor(() => expect(card.textContent).toContain("Where did the Q3 budget go?"));
    expect(card.textContent).toContain("No agent");
    expect(card.textContent).toMatch(/Messages\s*2/);
    expect(card.querySelector("time")?.getAttribute("datetime")).toBe(
      fake.threads.get(t)?.last_activity_at,
    );
    expect(chatRequests(fake, "GET").some((r) => r.path === `/v1/threads/${t}/card`)).toBe(true);
  });

  it("moves to Trash from the row's menu and restores (D18)", async () => {
    const t = fake.addThread("Budget");
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    openApp(fake);
    const user = userEvent.setup();
    await list();
    await trashFromMenu(user, "Budget");
    await waitFor(() => expect(fake.threads.get(t)?.deleted_at).not.toBeNull());
    expect(chatRequests(fake, "DELETE").at(-1)).toMatchObject({
      path: `/v1/threads/${t}`,
      team: fake.teamId,
    });
    await user.click(screen.getByRole("button", { name: "Trash" }));
    expect(screen.getByText("Threads in Trash are deleted for good after 30 days.")).toBeTruthy();
    const trash = within(await threadGroup("Trash"));
    // Trash rows keep their own two actions, no menu.
    expect(trash.queryByRole("button", { name: "Actions for Budget" })).toBeNull();
    await user.click(await trash.findByRole("button", { name: "Restore Budget" }));
    await waitFor(() => expect(fake.threads.get(t)?.deleted_at).toBeNull());
    expect(chatRequests(fake, "POST").at(-1)?.path).toBe(`/v1/threads/${t}/restore`);
  });

  it("deletes a thread in Trash forever after confirming (KOBE-18)", async () => {
    const t = fake.addThread("Old plan");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    openApp(fake);
    const user = userEvent.setup();
    await list();
    await trashFromMenu(user, "Old plan");
    await waitFor(() => expect(fake.threads.get(t)?.deleted_at).not.toBeNull());
    expect(confirm).not.toHaveBeenCalled(); // Trash is undoable: only Delete forever asks
    await user.click(screen.getByRole("button", { name: "Trash" }));
    const trash = within(await threadGroup("Trash"));
    // Cancelled: nothing is sent.
    await user.click(await trash.findByRole("button", { name: "Delete Old plan forever" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(fake.threads.has(t)).toBe(true);
    confirm.mockReturnValue(true);
    await user.click(trash.getByRole("button", { name: "Delete Old plan forever" }));
    await waitFor(() => expect(fake.threads.has(t)).toBe(false));
    expect(chatRequests(fake, "POST").at(-1)).toMatchObject({
      path: `/v1/threads/${t}/purge`,
      team: fake.teamId,
    });
    // An empty Trash is hidden (CE5).
    await waitFor(() => expect(screen.queryByRole("button", { name: "Trash" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Delete Old plan forever" })).toBeNull();
  });

  it("offers the export of the team's conversations as a download (KOBE-18)", async () => {
    openApp(fake);
    // In the Threads panel since KOBE-453.
    const link = await within(await openThreads()).findByRole("link", {
      name: "Export my conversations",
    });
    expect(link.getAttribute("href")).toBe(`/v1/threads/export?team=${fake.teamId}`);
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("tells members about an upcoming retention shortening, with the export link (KOBE-18)", async () => {
    fake.upcomingRetention = { period: "90d", effective_at: "2026-10-11T03:00:00.000Z" };
    openApp(fake);
    const notice = await screen.findByText(/older than 90 days will be deleted from/);
    const link = within(notice).getByRole("link", { name: "Export your conversations" });
    expect(link.getAttribute("href")).toBe(`/v1/threads/export?team=${fake.teamId}`);
  });

  it("closes the retention notice and keeps it closed until the notice changes", async () => {
    fake.upcomingRetention = { period: "90d", effective_at: "2026-10-11T03:00:00.000Z" };
    openApp(fake);
    const user = userEvent.setup();
    await screen.findByText(/older than 90 days will be deleted from/);
    expect(crushedIconButtons()).toEqual([]); // KOBE-269: the close icon keeps its size
    await user.click(screen.getByRole("button", { name: "Dismiss retention notice" }));
    expect(screen.queryByText(/will be deleted from/)).toBeNull();

    cleanup();
    openApp(fake);
    await openThreads();
    await screen.findByText("No threads yet.");
    expect(screen.queryByText(/will be deleted from/)).toBeNull();

    cleanup();
    fake.upcomingRetention = { period: "30d", effective_at: "2026-10-16T03:00:00.000Z" };
    openApp(fake);
    expect(await screen.findByText(/older than 30 days will be deleted from/)).toBeTruthy();
  });

  it("shows the server's refusal to Trash a busy thread", async () => {
    const t = fake.addThread("Busy");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "work{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    await trashFromMenu(user, "Busy");
    expect((await screen.findAllByText("Stop the run and clear the queue first."))[0]).toBeTruthy();
    expect(fake.threads.get(t)?.deleted_at).toBeNull();
  });

  it("searches with ?q= and shows snippets as plain text (KOBE-33)", async () => {
    fake.addThread("Quarterly <b>revenue</b>");
    const other = fake.addThread("Hiring plan");
    openApp(fake);
    const user = userEvent.setup();
    await list();
    await closeThreads();
    await user.type(screen.getByLabelText("Search conversations"), "revenue{Enter}");
    const results = within(await screen.findByRole("list", { name: "Search results" }));
    expect(results.getAllByRole("listitem")).toHaveLength(1);
    expect(document.querySelector("b")).toBeNull(); // escaped, never parsed as HTML
    expect(results.getByText("Quarterly <b>revenue</b>", { selector: "mark" })).toBeTruthy();
    expect(chatRequests(fake, "GET").some((r) => r.path === "/v1/threads?q=revenue")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(await within(await list()).findByRole("button", { name: "Hiring plan" })).toBeTruthy();
    expect(other).toBeTruthy();
  });

  it("sends X-Kobe-Team on every thread and run request", async () => {
    const t = fake.addThread("Teamed");
    openApp(fake, t);
    await userEvent.setup().type(await composer(), "hi{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    await streaming(fake);
    // EventSource can't set headers; the stream needs none (KOBE-31) and is filtered out here.
    const scoped = chatRequests(fake).filter((r) => r.method !== "SSE");
    expect(scoped.length).toBeGreaterThan(5);
    expect(scoped.filter((r) => r.team !== fake.teamId)).toEqual([]);
  });
});

describe("errors", () => {
  it("renders 404 for an unknown or invisible thread", async () => {
    openApp(fake, "00000000-0000-4000-8000-00009999aaaa");
    expect((await screen.findAllByText("No thread with that id."))[0]).toBeTruthy();
  });

  it("renders 403 with the way out, and team_mismatch with Reload", async () => {
    const t = fake.addThread("Mine");
    fake.failNext.set(
      `GET /v1/threads/${t}`,
      new Response(JSON.stringify({ code: "forbidden", message: "You can't do that." }), {
        status: 403,
      }),
    );
    openApp(fake, t);
    expect(
      await screen.findByText(
        "Your access may have changed. Ask a site or team admin if you need it.",
      ),
    ).toBeTruthy();
    cleanup();

    fake.failNext.set(
      `GET /v1/threads/${t}`,
      new Response(
        JSON.stringify({ code: "team_mismatch", message: "Another tab switched teams." }),
        { status: 409 },
      ),
    );
    openApp(fake, t);
    expect(await screen.findByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("503 isolation_unavailable on send: explains, and the message goes back into the composer", async () => {
    const t = fake.addThread("Iso");
    openApp(fake, t);
    fake.failNext.set(
      `POST /v1/threads/${t}/messages`,
      new Response(
        JSON.stringify({
          code: "isolation_unavailable",
          message: "Agents are disabled: the sandbox isolation runtime is not available.",
        }),
        { status: 503 },
      ),
    );
    const box = await composer();
    await userEvent.setup().type(box, "hello?{Enter}");
    expect(
      await screen.findByText(
        "Agents are disabled: the sandbox isolation runtime is not available.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Agents are disabled until the cluster has a gVisor or Kata runtime/),
    ).toBeTruthy();
    await waitFor(() => expect(box.value).toBe("hello?"));
  });

  it("409 thread_busy on a branch switch: shows it and stays on the branch", async () => {
    const t = fake.addThread("B");
    const u1 = fake.addEntry(t, null, { role: "user", content: "start" });
    const a1 = fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "a1" }] });
    const u2 = fake.addEntry(t, a1, { role: "user", content: "v1" });
    fake.addEntry(t, u2, { role: "assistant", content: [{ type: "text", text: "answer v1" }] });
    const u2b = fake.addEntry(t, a1, { role: "user", content: "v2" });
    fake.addEntry(t, u2b, { role: "assistant", content: [{ type: "text", text: "answer v2" }] });
    fake.failNext.set(
      `POST /v1/threads/${t}/leaf`,
      new Response(
        JSON.stringify({ code: "thread_busy", message: "The thread is busy. Try again." }),
        { status: 409 },
      ),
    );
    openApp(fake, t);
    await screen.findByText("answer v2");
    await userEvent
      .setup()
      .click(must(screen.getAllByRole("button", { name: "Previous version" })[0]));
    expect(await screen.findByText("The thread is busy. Try again.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("answer v2")).toBeTruthy());
    expect(fake.threads.get(t)?.leaf_entry_id).not.toBe(u2);
  });

  it("a compacted run (410) falls back to the entries", async () => {
    const t = fake.addThread("Old");
    openApp(fake, t);
    await userEvent.setup().type(await composer(), "go{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const run = must(fake.activeRun(t));
    await streaming(fake, run.run_id);
    fake.agent.commitPrompt(run.run_id);
    fake.agent.commit(run.run_id, {
      role: "assistant",
      content: [{ type: "text", text: "from the entries" }],
    });
    // The run ends and its events are compacted before the client hears the end.
    const thread = must(fake.threads.get(t));
    thread.leaf_entry_id = fake.run(run.run_id).tip;
    thread.status = "idle";
    fake.run(run.run_id).status = "completed";
    fake.run(run.run_id).compacted = true;
    fake.dropConnections();
    expect(await screen.findByText(streamed("from the entries"))).toBeTruthy();
    await waitFor(() => expect(fake.openStreams).toHaveLength(0));
  });
});

describe("accessibility", () => {
  it("has a skip link, labelled regions and controls, and announces run changes politely", async () => {
    const t = fake.addThread("A11y");
    openApp(fake, t);
    const skip = await screen.findByRole("link", { name: "Skip to the conversation" });
    expect(skip.getAttribute("href")).toBe("#kobe-chat-main");
    expect(document.getElementById("kobe-chat-main")?.tagName).toBe("MAIN");
    expect(screen.getByRole("complementary", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByRole("search")).toBeTruthy();
    expect(await screen.findByRole("region", { name: "A11y" })).toBeTruthy();
    const box = await composer();
    expect(box.getAttribute("aria-describedby")).toBe("kobe-composer-hint");

    const user = userEvent.setup();
    await user.type(box, "hi{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const run = must(fake.activeRun(t));
    await streaming(fake, run.run_id);
    fake.agent.delta(run.run_id, "m1", "streaming text");
    const text = await screen.findByText(streamed("streaming text"));
    expect(text.closest('[aria-busy="true"]')).toBeTruthy();
    expect(
      screen.getByText("Enter queues · Ctrl+Shift+Enter steers · Shift+Enter new line"),
    ).toBeTruthy();
    fake.agent.commitPrompt(run.run_id);
    fake.agent.commit(
      run.run_id,
      { role: "assistant", content: [{ type: "text", text: "streaming text" }] },
      "m1",
    );
    fake.agent.complete(run.run_id);
    await waitFor(() => expect(announcement()).toBe("The agent finished."));
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("starts the rail collapsed on narrow screens, and the bar opens it as a drawer", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: query.includes("max-width"), media: query }) as MediaQueryList,
    );
    openApp(fake);
    const rail = await screen.findByRole("complementary", { name: "Workspace" });
    expect(within(rail).queryByRole("heading", { name: "Files" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show the workspace" }));
    // The drawer is a modal dialog (KOBE-201).
    const drawer = await screen.findByRole("dialog", { name: "Workspace" });
    // Since KOBE-453 it holds Files, and Threads opens the Threads panel.
    expect(await within(drawer).findByRole("heading", { name: "Files" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Threads panel" })).toBeTruthy();
  });
});
