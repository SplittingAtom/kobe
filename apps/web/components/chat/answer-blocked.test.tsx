// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { announcement, composer, openApp, streaming } from "./testing";

/**
 * KOBE-605: an answer keeps its blocked-egress cards after its run ended, while the next run
 * streams and after a reload (read back from `GET /v1/threads/{id}/egress-blocked`), once each,
 * and a closed card stays closed (KOBE-468).
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

const blockedCards = (host: string) =>
  screen
    .queryAllByRole("note")
    .filter((n) => n.textContent?.includes(`Internet access to ${host} was blocked`));

async function turn(t: string, text: string, answer: string, block?: string) {
  const user = userEvent.setup();
  await user.type(await composer(), `${text}{Enter}`);
  await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
  const runId = must(fake.activeRun(t)).run_id;
  await streaming(fake, runId);
  fake.agent.commitPrompt(runId);
  if (block !== undefined) {
    fake.emit(runId, "egress.blocked", {
      domain: block,
      request_access: true,
      reason: "not_in_ceiling",
    });
  }
  fake.agent.commit(runId, { role: "assistant", content: [{ type: "text", text: answer }] }, "m1");
  fake.agent.complete(runId);
  await waitFor(() => expect(announcement()).toBe("The agent finished."));
  return { user, runId };
}

describe("blocked cards outlive their run (KOBE-605)", () => {
  it("keeps the card on its answer through the next run and a reload, once", async () => {
    const t = fake.addThread("Fetch");
    const first = openApp(fake, t);
    await turn(t, "fetch it", "first answer", "example.org");
    await waitFor(() => expect(blockedCards("example.org")).toHaveLength(1));

    // The next run is followed now: the first answer still shows its card, once.
    await turn(t, "again", "second answer");
    expect(await screen.findByText("second answer")).toBeTruthy();
    await waitFor(() => expect(blockedCards("example.org")).toHaveLength(1));
    const card = must(blockedCards("example.org")[0]);
    expect(card.closest('[data-role="assistant"]')?.textContent).toContain("first answer");

    // After a reload no run is followed; the card is read back.
    first.unmount();
    openApp(fake, t);
    expect(await screen.findByText("second answer")).toBeTruthy();
    await waitFor(() => expect(blockedCards("example.org")).toHaveLength(1));
    expect(fake.egressBlockedReads).toBeGreaterThan(0);
  });

  it("a card closed on the live run stays closed on its answer and after a reload", async () => {
    const t = fake.addThread("Fetch");
    const first = openApp(fake, t);
    const { user } = await turn(t, "fetch it", "first answer", "example.org");
    await user.click(await screen.findByRole("button", { name: "Close notice about example.org" }));
    expect(blockedCards("example.org")).toHaveLength(0);
    await turn(t, "again", "second answer");
    first.unmount();
    openApp(fake, t);
    expect(await screen.findByText("second answer")).toBeTruthy();
    await waitFor(() => expect(fake.egressBlockedReads).toBeGreaterThan(1));
    expect(blockedCards("example.org")).toHaveLength(0);
  });
});
