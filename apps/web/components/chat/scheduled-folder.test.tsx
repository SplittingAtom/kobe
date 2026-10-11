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
  it("holds only schedule threads and keeps them out of Conversations", async () => {
    fake.addThread("Plain chat");
    const ran = fake.addThread("Morning digest");
    fake.setScheduleId(ran, SCHEDULE);
    openApp(fake);
    const user = userEvent.setup();
    const conversations = within(await screen.findByRole("list", { name: "Your conversations" }));
    await waitFor(() =>
      expect(conversations.getByRole("button", { name: "Plain chat" })).toBeTruthy(),
    );
    expect(conversations.queryByRole("button", { name: "Morning digest" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Scheduled" }));
    const scheduled = within(await screen.findByRole("list", { name: "Scheduled" }));
    expect(scheduled.getByRole("button", { name: "Morning digest" })).toBeTruthy();
    expect(scheduled.queryByRole("button", { name: "Plain chat" })).toBeNull();
  });
});
