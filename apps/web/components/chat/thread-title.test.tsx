// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { chatRequests, composer, openApp, threadGroup } from "./testing";

/**
 * KOBE-292 (ac-2): the conversation header shows the thread's name with a pencil; the name edits
 * in place (Enter saves through the rename API, Escape cancels) and the rail follows at once.
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

const heading = () => screen.findByRole("heading", { level: 2, name: "Budget" });
const header = async () => must((await heading()).closest("header"));
const rail = () => threadGroup("Your threads");
const patches = () => chatRequests(fake, "PATCH");

describe("conversation header name (KOBE-292)", () => {
  it("renames in place on Enter, and the rail shows the new name", async () => {
    const t = fake.addThread("Budget");
    openApp(fake, t);
    const user = userEvent.setup();
    const pencil = within(await header()).getByRole("button", { name: "Rename Budget" });
    await user.click(pencil);
    const input = screen.getByRole("textbox", { name: "Conversation name" });
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).value).toBe("Budget");
    await user.clear(input);
    await user.type(input, "Budget 2027{Enter}");
    await waitFor(() => expect(fake.threads.get(t)?.title).toBe("Budget 2027"));
    expect(patches().at(-1)).toMatchObject({
      path: `/v1/threads/${t}`,
      body: { title: "Budget 2027" },
      team: fake.teamId,
    });
    expect(await screen.findByRole("heading", { level: 2, name: "Budget 2027" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Conversation name" })).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Rename Budget 2027");
    expect(within(await rail()).getByRole("button", { name: "Budget 2027" })).toBeTruthy();
  });

  it("Escape cancels: nothing is sent and the name stays", async () => {
    const t = fake.addThread("Budget");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(within(await header()).getByRole("button", { name: "Rename Budget" }));
    await user.type(screen.getByRole("textbox", { name: "Conversation name" }), " draft{Escape}");
    expect(screen.queryByRole("textbox", { name: "Conversation name" })).toBeNull();
    expect(await heading()).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Rename Budget");
    expect(patches()).toEqual([]);
  });

  it("an unchanged name sends nothing", async () => {
    const t = fake.addThread("Budget");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(within(await header()).getByRole("button", { name: "Rename Budget" }));
    await user.keyboard("{Enter}");
    expect(await heading()).toBeTruthy();
    expect(patches()).toEqual([]);
  });

  it("an empty name clears it: untitled, and unlocked on the server", async () => {
    const t = fake.addThread("Budget");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(within(await header()).getByRole("button", { name: "Rename Budget" }));
    await user.clear(screen.getByRole("textbox", { name: "Conversation name" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fake.threads.get(t)?.title).toBeNull());
    expect(patches().at(-1)?.body).toEqual({ title: null });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Untitled conversation" }),
    ).toBeTruthy();
    expect(
      within(await rail()).getByRole("button", { name: "Untitled conversation" }),
    ).toBeTruthy();
  });

  it("leaving the field saves a changed name", async () => {
    const t = fake.addThread("Budget");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(within(await header()).getByRole("button", { name: "Rename Budget" }));
    await user.type(screen.getByRole("textbox", { name: "Conversation name" }), " review");
    await user.click(await composer());
    await waitFor(() => expect(fake.threads.get(t)?.title).toBe("Budget review"));
    expect(screen.queryByRole("textbox", { name: "Conversation name" })).toBeNull();
    // The focus stays where the member put it.
    expect(document.activeElement).toBe(await composer());
  });

  it("a refused rename keeps the field open with the server's reason", async () => {
    const t = fake.addThread("Budget");
    fake.failNext.set(
      `PATCH /v1/threads/${t}`,
      Response.json(
        { code: "thread_in_trash", message: "Restore the thread first." },
        { status: 409 },
      ),
    );
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(within(await header()).getByRole("button", { name: "Rename Budget" }));
    const input = screen.getByRole("textbox", { name: "Conversation name" });
    await user.type(input, " 2027{Enter}");
    const alert = (await screen.findAllByText("Restore the thread first.")).find(
      (el) => el.getAttribute("role") === "alert" && el.closest("header") !== null,
    );
    expect(alert).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("Budget 2027");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(fake.threads.get(t)?.title).toBe("Budget");
    // Trying again succeeds and closes it.
    await user.type(input, "{Enter}");
    await waitFor(() => expect(fake.threads.get(t)?.title).toBe("Budget 2027"));
    expect(screen.queryByRole("textbox", { name: "Conversation name" })).toBeNull();
  });

  it("offers no pencil on a new conversation, a read-only one or one in Trash", async () => {
    openApp(fake);
    await composer();
    expect(await screen.findByRole("heading", { level: 2, name: "New conversation" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Rename/ })).toBeNull();
    cleanup();

    const shared = fake.addThread("Budget");
    must(fake.threads.get(shared)).read_only = true;
    openApp(fake, shared);
    await heading();
    expect(screen.queryByRole("button", { name: "Rename Budget" })).toBeNull();
    cleanup();

    const trashed = fake.addThread("Old");
    must(fake.threads.get(trashed)).deleted_at = "2026-10-15T00:00:00.000Z";
    openApp(fake, trashed);
    await screen.findByRole("heading", { level: 2, name: "Old" });
    expect(screen.queryByRole("button", { name: "Rename Old" })).toBeNull();
  });
});
