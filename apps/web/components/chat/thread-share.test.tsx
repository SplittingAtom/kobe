// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { chatRequests, openApp, openRowMenu, openThreads } from "./testing";

/**
 * KOBE-221 (CE20): Share from a thread row's ⋯ menu (only you, the project's members, everyone in
 * the team) and revoke it there; a reader's thread opens read-only with "Shared by <author>" and
 * Fork; the rail lists others' shared threads under Shared with me, project-scoped ones also in
 * their project group.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The titles of each rail group (only open groups list their rows). */
function groups(): [string, string[]][] {
  return [...document.querySelectorAll<HTMLElement>("[data-group]")].map((g) => [
    g.dataset.group ?? "",
    [...g.querySelectorAll("[data-kobe-thread]")].map(
      (row) => row.querySelector("button")?.textContent ?? "",
    ),
  ]);
}

/** Opens a submenu by keyboard (happy-dom has no layout for Radix's pointer grace area). */
async function submenu(menuName: string, item: string): Promise<HTMLElement> {
  const menu = await openRowMenu(menuName);
  const trigger = await waitFor(() => {
    const found = within(menu).getByRole("menuitem", { name: item });
    expect(found.getAttribute("aria-disabled"), found.getAttribute("title") ?? "").toBeNull();
    return found;
  });
  trigger.focus();
  await userEvent.setup().keyboard("{ArrowRight}");
  return screen.findByRole("menu", { name: item });
}

const choices = (sub: HTMLElement) =>
  within(sub)
    .getAllByRole("menuitem")
    .map((i) => i.textContent);

const status = () => document.querySelector("[data-kobe-rail-status]")?.textContent ?? "";

/** Someone else's thread shared with the viewer. */
function sharedWithMe(title: string, visibility: "project" | "team", projectId?: string) {
  const id = fake.addThread(title);
  const thread = must(fake.threads.get(id));
  Object.assign(thread, {
    read_only: true,
    visibility,
    owner_name: "Alice Author",
    project_id: projectId ?? null,
  });
  fake.addEntry(id, null, { role: "user", content: "from the author" });
  return id;
}

describe("share from the thread menu (ac-1)", () => {
  it("shares with the team and revokes it again, the scope marked current", async () => {
    const t = fake.addThread("Budget");
    openApp(fake);
    await openThreads();
    await screen.findByRole("button", { name: "Actions for Budget" });
    let sub = await submenu("Actions for Budget", "Share");
    // Outside a project there is no project scope to offer.
    expect(choices(sub)).toEqual(["Only you (current)", "Everyone in the team"]);
    within(sub).getByRole("menuitem", { name: "Everyone in the team" }).focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(fake.threads.get(t)?.visibility).toBe("team"));
    expect(chatRequests(fake, "POST").at(-1)).toMatchObject({
      path: `/v1/threads/${t}/share`,
      body: { visibility: "team" },
    });
    await waitFor(() =>
      expect(status()).toBe(
        "Shared “Budget” with everyone in the team: they can read and fork it.",
      ),
    );

    sub = await submenu("Actions for Budget", "Share");
    expect(choices(sub)).toEqual(["Only you", "Everyone in the team (current)"]);
    within(sub).getByRole("menuitem", { name: "Only you" }).focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(fake.threads.get(t)?.visibility).toBe("private"));
    expect(chatRequests(fake, "POST").at(-1)?.body).toEqual({ visibility: "private" });
    await waitFor(() => expect(status()).toBe("“Budget” is private again: only you can see it."));
  });

  it("offers the project's members for a thread in a project", async () => {
    const q4 = fake.addProject("Q4");
    const t = fake.addThread("Budget");
    must(fake.threads.get(t)).project_id = q4;
    openApp(fake);
    await openThreads();
    await screen.findByRole("button", { name: "Actions for Budget" });
    const sub = await submenu("Actions for Budget", "Share");
    expect(choices(sub)).toEqual(["Only you (current)", "Project members", "Everyone in the team"]);
    within(sub).getByRole("menuitem", { name: "Project members" }).focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(fake.threads.get(t)?.visibility).toBe("project"));
  });

  it("says why sharing was refused", async () => {
    const t = fake.addThread("Budget");
    fake.failNext.set(
      `POST /v1/threads/${t}/share`,
      new Response(JSON.stringify({ code: "thread_busy", message: "The thread is busy." }), {
        status: 409,
      }),
    );
    openApp(fake);
    await openThreads();
    await screen.findByRole("button", { name: "Actions for Budget" });
    const sub = await submenu("Actions for Budget", "Share");
    within(sub).getByRole("menuitem", { name: "Everyone in the team" }).focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(status()).toBe("The thread is busy."));
    expect(fake.threads.get(t)?.visibility).toBeUndefined();
  });

  it("is unavailable on a thread shared with you, with the reason", async () => {
    sharedWithMe("Their plan", "team");
    openApp(fake);
    await openThreads();
    const menu = await openRowMenu("Actions for Their plan");
    const item = within(menu).getByRole("menuitem", { name: "Share" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("title")).toBe(
      "This conversation is shared with you read-only: only its owner can share it.",
    );
  });
});

describe("Shared with me (ac-2)", () => {
  it("lists others' shared threads, a project-scoped one also in its project group", async () => {
    const q4 = fake.addProject("Q4");
    fake.addThread("Mine");
    sharedWithMe("Team notes", "team");
    sharedWithMe("Project notes", "project", q4);
    openApp(fake);
    await openThreads();
    await screen.findByRole("button", { name: "Actions for Mine" });
    await waitFor(() =>
      expect(groups()).toEqual([
        ["project", ["Project notes"]],
        ["ungrouped", ["Mine"]],
        ["shared", ["Project notes", "Team notes"]],
      ]),
    );
    expect(chatRequests(fake, "GET").some((r) => r.path.startsWith("/v1/threads/shared"))).toBe(
      true,
    );
  });
});

describe("read-only view (ac-1)", () => {
  it("names the author in the banner and forks into a private thread", async () => {
    const id = sharedWithMe("Their plan", "team");
    openApp(fake, id);
    await openThreads();
    const banner = await screen.findByRole("note", { name: "Shared thread" });
    expect(banner.textContent).toContain("Shared by Alice Author.");
    expect(banner.textContent).toMatch(/shared with you read-only/);
    expect(screen.queryByLabelText("Message")).toBeNull();
    await userEvent
      .setup()
      .click(within(banner).getByRole("button", { name: "Fork into my conversations" }));
    await waitFor(() => expect(fake.threads.size).toBe(2));
    expect(await screen.findByLabelText("Message")).toBeTruthy();
  });

  it("names the thread's agent in the banner, and nothing when it has none (KOBE-418)", async () => {
    const id = sharedWithMe("Agent plan", "team");
    Object.assign(must(fake.threads.get(id)), {
      agent_id: "a-ledger",
      agent_name: "Ledger Bot",
      agent_status: "suspended",
    });
    openApp(fake, id);
    await openThreads();
    const banner = await screen.findByRole("note", { name: "Shared thread" });
    expect(await within(banner).findByText("Agent: Ledger Bot")).toBeTruthy();
    expect(within(banner).getByText("Suspended")).toBeTruthy();
    cleanup();
    const plain = sharedWithMe("Plain plan", "team");
    openApp(fake, plain);
    await openThreads();
    const again = await screen.findByRole("note", { name: "Shared thread" });
    expect(within(again).queryByText(/^Agent: /)).toBeNull();
  });

  it("says a former member shared it when the author left the team", async () => {
    const id = sharedWithMe("Old plan", "team");
    must(fake.threads.get(id)).owner_name = null;
    openApp(fake, id);
    await openThreads();
    const banner = await screen.findByRole("note", { name: "Shared thread" });
    expect(banner.textContent).toContain("Shared by a former member.");
  });

  it("tells the owner of a team-shared thread and makes it private from the bar", async () => {
    const t = fake.addThread("Budget");
    must(fake.threads.get(t)).visibility = "team";
    fake.addEntry(t, null, { role: "user", content: "hello" });
    openApp(fake, t);
    await openThreads();
    const bar = await screen.findByRole("group", { name: "Sharing" });
    expect(bar.textContent).toContain("Everyone in the team can read and fork this conversation.");
    await userEvent.setup().click(within(bar).getByRole("button", { name: "Make private" }));
    await waitFor(() => expect(fake.threads.get(t)?.visibility).toBe("private"));
  });
});
