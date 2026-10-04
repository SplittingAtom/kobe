// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { announcement, chatRequests, composer, openApp, streaming } from "./testing";
import { must } from "../../lib/testing/must";

let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear(); // resume points are per tab; each test is a fresh tab
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const list = () => screen.findByRole("list", { name: "Your conversations" });

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
    expect(await screen.findByText("hello from newer")).toBeTruthy();
    expect(window.location.search).toBe(`?thread=${newer}`);
  });

  it("creates a thread on the first message, titled with its first line", async () => {
    openApp(fake);
    const user = userEvent.setup();
    await list();
    await user.type(
      await composer(),
      "Plot revenue by month{Shift>}{Enter}{/Shift}in a bar chart{Enter}",
    );
    await waitFor(() => expect(fake.threads.size).toBe(1));
    const [thread] = [...fake.threads.values()];
    expect(thread?.title).toBe("Plot revenue by month");
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

  it("renames, moves to Trash and restores (D18)", async () => {
    const t = fake.addThread("Budget");
    openApp(fake);
    const user = userEvent.setup();
    const items = within(await list());
    await user.click(await items.findByRole("button", { name: "Rename Budget" }));
    const input = screen.getByLabelText("New title for Budget");
    await user.clear(input);
    await user.type(input, "Budget 2027{Enter}");
    await waitFor(() => expect(fake.threads.get(t)?.title).toBe("Budget 2027"));
    expect(chatRequests(fake, "PATCH").at(-1)).toMatchObject({
      body: { title: "Budget 2027" },
      team: fake.teamId,
    });

    await user.click(await items.findByRole("button", { name: "Move Budget 2027 to Trash" }));
    await waitFor(() => expect(fake.threads.get(t)?.deleted_at).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Trash" }));
    expect(
      screen.getByText("Conversations in Trash are deleted for good after 30 days."),
    ).toBeTruthy();
    const trash = within(await screen.findByRole("list", { name: "Trash" }));
    await user.click(await trash.findByRole("button", { name: "Restore Budget 2027" }));
    await waitFor(() => expect(fake.threads.get(t)?.deleted_at).toBeNull());
    expect(chatRequests(fake, "POST").at(-1)?.path).toBe(`/v1/threads/${t}/restore`);
  });

  it("deletes a thread in Trash forever after confirming (KOBE-18)", async () => {
    const t = fake.addThread("Old plan");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    openApp(fake);
    const user = userEvent.setup();
    await user.click(
      await within(await list()).findByRole("button", { name: "Move Old plan to Trash" }),
    );
    await waitFor(() => expect(fake.threads.get(t)?.deleted_at).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Trash" }));
    const trash = within(await screen.findByRole("list", { name: "Trash" }));
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
    await waitFor(() =>
      expect(trash.queryByRole("button", { name: "Delete Old plan forever" })).toBeNull(),
    );
  });

  it("offers the export of the team's conversations as a download (KOBE-18)", async () => {
    openApp(fake);
    const link = await screen.findByRole("link", { name: "Export my conversations" });
    expect(link.getAttribute("href")).toBe(`/v1/threads/export?team=${fake.teamId}`);
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("shows the server's refusal to Trash a busy thread", async () => {
    const t = fake.addThread("Busy");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "work{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    await user.click(
      await within(await list()).findByRole("button", { name: "Move Busy to Trash" }),
    );
    expect((await screen.findAllByText("Stop the run and clear the queue first."))[0]).toBeTruthy();
    expect(fake.threads.get(t)?.deleted_at).toBeNull();
  });

  it("searches with ?q= and shows snippets as plain text (KOBE-33)", async () => {
    fake.addThread("Quarterly <b>revenue</b>");
    const other = fake.addThread("Hiring plan");
    openApp(fake);
    const user = userEvent.setup();
    await list();
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
        "Your access may have changed. Ask an install or team admin if you need it.",
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
    expect(await screen.findByText("from the entries")).toBeTruthy();
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
    expect(screen.getByRole("complementary", { name: "Conversations" })).toBeTruthy();
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
    const text = await screen.findByText("streaming text");
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

  it("folds the conversation list behind a toggle on narrow screens", async () => {
    openApp(fake);
    const toggle = await screen.findByRole("button", { name: "Show conversations" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.setup().click(toggle);
    expect(
      screen.getByRole("button", { name: "Hide conversations" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});
