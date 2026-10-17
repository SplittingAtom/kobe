// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { chatRequests, openApp } from "./testing";

/**
 * KOBE-275 ac-1: thumbs up and down on each answer, saved on the click; a thumbs down offers
 * reason chips and an optional comment; the pressed thumb clears the rating; a reader of a shared
 * thread rates for themselves; the rating is read back on reload.
 */
let fake: FakeKobe;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

const say = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const ask = (content: string) => ({ role: "user", content });

/** Two answered prompts; returns the thread, both runs and the answers' entry ids. */
function answeredThread() {
  const thread = fake.addThread("Numbers");
  const u1 = fake.addEntry(thread, null, ask("What is 2+2?"));
  const a1 = fake.addEntry(thread, u1, say("Four."));
  const u2 = fake.addEntry(thread, a1, ask("And 3+3?"));
  const a2 = fake.addEntry(thread, u2, say("Seven."));
  const r1 = fake.addEndedRun(thread, u1);
  const r2 = fake.addEndedRun(thread, u2);
  return { thread, r1, r2, a1, a2 };
}

/** The answers' rows of actions, in order. */
async function answerBars(n = 2): Promise<HTMLElement[]> {
  await waitFor(
    () => expect(screen.getAllByRole("button", { name: "Good answer" })).toHaveLength(n),
    { timeout: 4_000 },
  );
  return screen
    .getAllByRole("button", { name: "Good answer" })
    .map((b) => b.parentElement as HTMLElement);
}

const thumbs = (bar: HTMLElement) => ({
  up: within(bar).getByRole("button", { name: "Good answer" }),
  down: within(bar).getByRole("button", { name: "Bad answer" }),
});

const feedbackRequests = (method: string) =>
  chatRequests(fake, method).filter((r) => r.path.endsWith("/feedback"));

describe("answer feedback (KOBE-275)", () => {
  it("saves a thumbs up on the click, switches to down, and clears on the pressed thumb", async () => {
    const x = answeredThread();
    const user = userEvent.setup();
    openApp(fake, x.thread);
    const [first, second] = await answerBars();
    const one = thumbs(first as HTMLElement);
    expect(one.up.getAttribute("aria-pressed")).toBe("false");

    await user.click(one.up);
    await waitFor(() => expect(one.up.getAttribute("aria-pressed")).toBe("true"));
    expect(fake.feedback.get(x.r1)).toMatchObject({ rating: "up", entry_id: x.a1 });
    // The other answer is untouched.
    expect(thumbs(second as HTMLElement).up.getAttribute("aria-pressed")).toBe("false");

    await user.click(one.down);
    await waitFor(() => expect(one.down.getAttribute("aria-pressed")).toBe("true"));
    expect(one.up.getAttribute("aria-pressed")).toBe("false");
    expect(fake.feedback.get(x.r1)).toMatchObject({ rating: "down", reasons: [], comment: null });
    expect(screen.getByRole("form", { name: "What went wrong?" })).toBeTruthy();

    await user.click(one.down);
    await waitFor(() => expect(one.down.getAttribute("aria-pressed")).toBe("false"));
    expect(fake.feedback.has(x.r1)).toBe(false);
    expect(screen.queryByRole("form", { name: "What went wrong?" })).toBeNull();
    expect(feedbackRequests("DELETE").map((r) => r.path)).toEqual([`/v1/runs/${x.r1}/feedback`]);
  });

  it("takes reason chips and a short comment after a thumbs down, and reads them back on reload", async () => {
    const x = answeredThread();
    const user = userEvent.setup();
    const app = openApp(fake, x.thread);
    const [, second] = await answerBars();
    await user.click(thumbs(second as HTMLElement).down);
    const form = await screen.findByRole("form", { name: "What went wrong?" });
    const reasons = within(form).getByRole("group", { name: "Reasons" });
    await user.click(within(reasons).getByRole("button", { name: "Wrong or made up" }));
    await user.click(within(reasons).getByRole("button", { name: "Too slow" }));
    await user.click(within(reasons).getByRole("button", { name: "Too slow" }));
    expect(
      within(reasons)
        .getByRole("button", { name: "Wrong or made up" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const comment = within(form).getByLabelText("Comment (only you see it)");
    expect(comment.getAttribute("maxlength")).toBe("500");
    await user.type(comment, "3+3 is six.");
    expect(within(form).getByText("11/500")).toBeTruthy();
    await user.click(within(form).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "What went wrong?" })).toBeNull(),
    );
    expect(fake.feedback.get(x.r2)).toMatchObject({
      rating: "down",
      reasons: ["wrong"],
      comment: "3+3 is six.",
      entry_id: x.a2,
    });
    expect(feedbackRequests("PUT").at(-1)?.body).toEqual({
      rating: "down",
      reasons: ["wrong"],
      comment: "3+3 is six.",
      entry_id: x.a2,
    });

    // A reload reads the rating back; reopening the form shows what was sent.
    app.unmount();
    openApp(fake, x.thread);
    const [, again] = await answerBars();
    const down = thumbs(again as HTMLElement).down;
    await waitFor(() => expect(down.getAttribute("aria-pressed")).toBe("true"));
  });

  it("lets a reader of a shared thread rate for themselves", async () => {
    const x = answeredThread();
    const thread = fake.threads.get(x.thread);
    if (thread) Object.assign(thread, { read_only: true, visibility: "team", owner_name: "Ann" });
    const user = userEvent.setup();
    openApp(fake, x.thread);
    const [first] = await answerBars();
    // Read-only: no Regenerate, but the thumbs are there.
    expect(within(first as HTMLElement).queryByRole("button", { name: "Regenerate" })).toBeNull();
    await user.click(thumbs(first as HTMLElement).up);
    await waitFor(() => expect(fake.feedback.get(x.r1)).toMatchObject({ rating: "up" }));
  });

  it("shows no thumbs on an answer without an ended run, and says when a rating wasn't saved", async () => {
    const thread = fake.addThread("Pending");
    const u1 = fake.addEntry(thread, null, ask("Hi"));
    const a1 = fake.addEntry(thread, u1, say("Hello."));
    const u2 = fake.addEntry(thread, a1, ask("Bye"));
    fake.addEntry(thread, u2, say("Bye."));
    const r1 = fake.addEndedRun(thread, u1);
    const user = userEvent.setup();
    openApp(fake, thread);
    const [only] = await answerBars(1);
    fake.failNext.set(
      `PUT /v1/runs/${r1}/feedback`,
      new Response(JSON.stringify({ code: "legal_hold", message: "held" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    await user.click(thumbs(only as HTMLElement).up);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Your rating wasn't saved. Try again.",
    );
    expect(thumbs(only as HTMLElement).up.getAttribute("aria-pressed")).toBe("false");
  });
});
