// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { chatRequests, openApp } from "./testing";

/** KOBE-216 (CE16): "Fork to a new thread" from a message, the fork's marker, the rail hint. */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const text = (t: string) => [{ type: "text", text: t }];

/** "Quarterly plan": two questions and their answers. */
function source() {
  const id = fake.addThread("Quarterly plan");
  const u1 = fake.addEntry(id, null, { role: "user", content: "What drives revenue?" });
  const a1 = fake.addEntry(id, u1, { role: "assistant", content: text("Mostly renewals.") });
  const u2 = fake.addEntry(id, a1, { role: "user", content: "And costs?" });
  const a2 = fake.addEntry(id, u2, { role: "assistant", content: text("Mostly people.") });
  return { id, u1, a1, u2, a2 };
}

/** A fork of `src` at `entryId`, holding the copied entries; `named` = the viewer may open it. */
function forkOf(src: ReturnType<typeof source>, entryId: string, named: boolean) {
  const id = fake.addThread("Renewals deep dive");
  const fork = must(fake.threads.get(id));
  const copied = must(fake.threads.get(src.id)).entries;
  fork.entries = copied.slice(0, copied.findIndex((e) => e.entry_id === entryId) + 1);
  fork.leaf_entry_id = entryId;
  fork.forked_from_thread_id = named ? src.id : null;
  fork.forked_from_title = named ? "Quarterly plan" : null;
  fork.forked_at_entry_id = entryId;
  return id;
}

describe("fork to a new thread from a message (ac-1)", () => {
  it("asks for a title, forks at that message and opens the fork", async () => {
    const src = source();
    openApp(fake, src.id);
    const user = userEvent.setup();
    await screen.findByText("Mostly people.");
    const forks = screen.getAllByRole("button", { name: "Fork to a new thread" });
    // Answer 1, question 2, answer 2 (the first question has nothing above it to fork at).
    expect(forks).toHaveLength(3);
    await user.click(must(forks[0]));

    const dialog = await screen.findByRole("dialog", { name: "Fork to a new thread" });
    const title = within(dialog).getByLabelText("Title of the new thread") as HTMLInputElement;
    expect(title.value).toBe("Quarterly plan");
    await user.clear(title);
    await user.type(title, "Renewals");
    await user.click(within(dialog).getByRole("button", { name: "Fork" }));

    await waitFor(() => expect(fake.threads.size).toBe(2));
    const fork = must([...fake.threads.keys()].find((k) => k !== src.id));
    expect(chatRequests(fake, "POST").find((r) => r.path.endsWith("/fork"))).toMatchObject({
      path: `/v1/threads/${src.id}/fork`,
      body: { entry_id: src.a1, title: "Renewals" },
    });
    await waitFor(() => expect(window.location.search).toBe(`?thread=${fork}`));
    // The fork ends at the chosen answer and says where it came from.
    expect(await screen.findByText("Mostly renewals.")).toBeTruthy();
    expect(screen.queryByText("Mostly people.")).toBeNull();
    const origin = await screen.findByRole("note", { name: "Fork origin" });
    expect(origin.textContent).toContain("Quarterly plan");
  });

  it("keeps the dialog open with the server's refusal", async () => {
    const src = source();
    fake.failNext.set(
      `POST /v1/threads/${src.id}/fork`,
      new Response(JSON.stringify({ code: "thread_not_found", message: "Thread not found." }), {
        status: 404,
      }),
    );
    openApp(fake, src.id);
    const user = userEvent.setup();
    await screen.findByText("Mostly people.");
    await user.click(must(screen.getAllByRole("button", { name: "Fork to a new thread" })[2]));
    const dialog = await screen.findByRole("dialog", { name: "Fork to a new thread" });
    await user.click(within(dialog).getByRole("button", { name: "Fork" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    // Shown once: in the dialog, not again in the thread's error banner.
    expect(screen.getAllByText("Thread not found.")).toHaveLength(1);
    expect(fake.threads.size).toBe(1);
  });

  it("forks a question just before it, with the question waiting in the new composer", async () => {
    const src = source();
    openApp(fake, src.id);
    const user = userEvent.setup();
    await screen.findByText("Mostly people.");
    await user.click(must(screen.getAllByRole("button", { name: "Fork to a new thread" })[1]));
    const dialog = await screen.findByRole("dialog", { name: "Fork to a new thread" });
    expect(dialog.textContent).toMatch(/Attached files are not copied/);
    await user.click(within(dialog).getByRole("button", { name: "Fork" }));
    await waitFor(() => expect(fake.threads.size).toBe(2));
    expect(chatRequests(fake, "POST").find((r) => r.path.endsWith("/fork"))?.body).toEqual({
      entry_id: src.a1,
      title: "Quarterly plan",
    });
    const fork = must([...fake.threads.keys()].find((k) => k !== src.id));
    await waitFor(() => expect(window.location.search).toBe(`?thread=${fork}`));
    await screen.findByText("Mostly renewals.");
    const shown = screen.queryAllByText("And costs?").filter((el) => el.tagName !== "TEXTAREA");
    expect(shown).toEqual([]);
    await waitFor(() =>
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("And costs?"),
    );
    // A draft, not sent.
    expect(chatRequests(fake, "POST").some((r) => r.path.endsWith("/messages"))).toBe(false);
  });
});

describe("the fork's origin (ac-1, ac-3, ac-6)", () => {
  it("names the source and the message, and links back to the source", async () => {
    const src = source();
    const fork = forkOf(src, src.a1, true);
    openApp(fake, fork);
    const origin = await screen.findByRole("note", { name: "Fork origin" });
    expect(origin.textContent).toMatch(/Forked from.*Quarterly plan.*at.*Mostly renewals\./);
    await userEvent.setup().click(within(origin).getByRole("link", { name: "Quarterly plan" }));
    await waitFor(() => expect(window.location.search).toBe(`?thread=${src.id}`));
    expect(await screen.findByText("Mostly people.")).toBeTruthy();
  });

  it("says only that it is a fork when the viewer can't open the source", async () => {
    const src = source();
    const fork = forkOf(src, src.u1, false);
    openApp(fake, fork);
    const origin = await screen.findByRole("note", { name: "Fork origin" });
    expect(origin.textContent).toMatch(
      /Forked from a thread you can.t open.*What drives revenue\?/,
    );
    expect(within(origin).queryByRole("link")).toBeNull();
  });

  it("leaves a modified click on the source link to the browser (new tab or window)", async () => {
    const src = source();
    const fork = forkOf(src, src.a1, true);
    openApp(fake, fork);
    const origin = await screen.findByRole("note", { name: "Fork origin" });
    const link = within(origin).getByRole("link", { name: "Quarterly plan" });
    expect(link.getAttribute("href")).toBe(`/?thread=${src.id}`);
    // Record what the app did, then stop happy-dom's own navigation.
    let prevented: boolean[] = [];
    const record = (e: Event) => {
      prevented = [...prevented, e.defaultPrevented];
      e.preventDefault();
    };
    window.addEventListener("click", record);
    try {
      for (const mods of [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
      ]) {
        link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...mods }));
      }
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 }));
    } finally {
      window.removeEventListener("click", record);
    }
    expect(prevented).toEqual([false, false, false, false, false]);
  });

  it("shows a copied prompt's attachments by name, though the files stay with the source", async () => {
    const src = source();
    const prompt =
      "See the deck\n\nAttached files:\n- /workspace/uploads/" +
      src.id +
      "/deck.pdf (application/pdf) - not shown inline; open it from this path";
    const u3 = fake.addEntry(src.id, src.a2, { role: "user", content: prompt });
    const a3 = fake.addEntry(src.id, u3, { role: "assistant", content: text("Read it.") });
    const fork = forkOf(src, a3, true);
    openApp(fake, fork);
    expect(await screen.findByText("See the deck")).toBeTruthy();
    const files = await screen.findByRole("list", { name: "Attached files" });
    expect(files.textContent).toContain("deck.pdf");
  });

  it("shows no origin on a thread that is not a fork", async () => {
    const src = source();
    openApp(fake, src.id);
    await screen.findByText("Mostly people.");
    expect(screen.queryByRole("note", { name: "Fork origin" })).toBeNull();
  });

  it("shows the provenance when hovering the fork in the rail", async () => {
    const src = source();
    const named = forkOf(src, src.a1, true);
    must(fake.threads.get(forkOf(src, src.u1, false))).title = "Hidden source";
    openApp(fake, named);
    const list = within(await screen.findByRole("list", { name: "Your threads" }));
    const item = await list.findByRole("button", { name: "Renewals deep dive" });
    expect(item.getAttribute("title")).toBe("Forked from “Quarterly plan”");
    const hidden = await list.findByRole("button", { name: "Hidden source" });
    expect(hidden.getAttribute("title")).toBe("Forked from a thread you can't open");
    expect(
      (await list.findByRole("button", { name: "Quarterly plan" })).getAttribute("title"),
    ).toBeNull();
  });
});
