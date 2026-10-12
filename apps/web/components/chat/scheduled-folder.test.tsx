// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { openApp } from "./testing";

let fake: FakeKobe;
const SCHEDULE = "00000000-0000-4000-8000-0000000005c1";

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Scheduled folder (KOBE-175, ac-3)", () => {
  it("holds only schedule threads and keeps them out of the others", async () => {
    fake.addThread("Plain chat");
    const ran = fake.addThread("Morning digest");
    fake.setScheduleId(ran, SCHEDULE);
    openApp(fake);
    const conversations = within(await screen.findByRole("list", { name: "Your threads" }));
    await waitFor(() =>
      expect(conversations.getByRole("button", { name: "Plain chat" })).toBeTruthy(),
    );
    expect(conversations.queryByRole("button", { name: "Morning digest" })).toBeNull();

    const scheduled = within(await screen.findByRole("list", { name: "Scheduled" }));
    expect(scheduled.getByRole("button", { name: "Morning digest" })).toBeTruthy();
    expect(scheduled.queryByRole("button", { name: "Plain chat" })).toBeNull();
  });
});

const SUMMARY = [
  "Skipped actions",
  "This scheduled run does not wait for approval, so 2 tool calls were skipped:",
  "- bash (changes data): scheduled runs cannot ask for approval and it is not allow-listed",
  "- <b>write</b> (changes data): blocked by policy",
].join("\n");

describe("a scheduled run's thread (KOBE-181)", () => {
  it("shows the skipped-actions summary as a card, as plain text, never as a branch (ac-1)", async () => {
    const t = fake.addThread("Nightly report");
    fake.setScheduleId(t, SCHEDULE);
    const u1 = fake.addEntry(t, null, { role: "user", content: "nightly" });
    const a1 = fake.addEntry(t, u1, {
      role: "assistant",
      content: [{ type: "text", text: "Ran" }],
    });
    fake.addSkippedSummary(t, a1, SUMMARY, 2);
    const u2 = fake.addEntry(t, a1, { role: "user", content: "why?" });
    fake.addEntry(t, u2, { role: "assistant", content: [{ type: "text", text: "Policy" }] });
    const { container } = openApp(fake, t);
    const card = within(await screen.findByRole("region", { name: "Skipped actions" }));
    expect(card.getByText("Skipped actions (2)")).toBeTruthy();
    expect(card.getByText(/does not wait for approval, so 2 tool calls were skipped/)).toBeTruthy();
    expect(card.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "bash (changes data): scheduled runs cannot ask for approval and it is not allow-listed",
      "<b>write</b> (changes data): blocked by policy",
    ]);
    expect(container.querySelector(".aui-thread-root b, main b")).toBeNull();
    await screen.findByText("Policy");
    expect(screen.queryByText(/^Version/)).toBeNull();
  });

  it("shows the card under the prompt of a run that failed before answering", async () => {
    const t = fake.addThread("Nightly report");
    fake.setScheduleId(t, SCHEDULE);
    const u1 = fake.addEntry(t, null, { role: "user", content: "nightly" });
    fake.addSkippedSummary(t, u1, SUMMARY, 2);
    openApp(fake, t);
    const card = within(await screen.findByRole("region", { name: "Skipped actions" }));
    expect(card.getByText("Skipped actions (2)")).toBeTruthy();
    expect(screen.getByText("nightly")).toBeTruthy();
  });

  it("the bell lists the run's notification and opens its Scheduled thread", async () => {
    fake.addThread("Plain chat");
    const t = fake.addThread("Morning digest");
    fake.setScheduleId(t, SCHEDULE);
    const u1 = fake.addEntry(t, null, { role: "user", content: "digest" });
    fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "Digest ready" }] });
    fake.notifications.push({
      notification_id: "00000000-0000-4000-8000-00000000a001",
      kind: "schedule.run.succeeded",
      schedule_id: SCHEDULE,
      thread_id: t,
      run_id: "00000000-0000-4000-8000-00000000b001",
      read_at: null,
      created_at: "2026-10-11T08:00:00Z",
    });
    openApp(fake);
    const user = userEvent.setup();
    const bell = await screen.findByRole("button", { name: "Notifications, 1 unread" });
    await user.click(bell);
    const panel = within(await screen.findByRole("region", { name: "Notifications" }));
    await user.click(await panel.findByRole("button", { name: /^Open conversation/ }));
    expect(await screen.findByText("Digest ready")).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("thread")).toBe(t);
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy());
  });
});
