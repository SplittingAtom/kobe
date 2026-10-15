// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { announcement, composer, openApp, streamed, streaming } from "./testing";

/**
 * KOBE-288: what the conversation shows once a run has ended, in the event orders the server
 * really sends. Found by the KOBE-285 browser suite on gate1.
 */
const WAITING = "Sent, waiting for the agent";

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

function threadWithHistory() {
  const t = fake.addThread("Sales");
  const u1 = fake.addEntry(t, null, { role: "user", content: "q1" });
  fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "a1" }] });
  return t;
}

async function sendAndStart(text: string, t: string) {
  const user = userEvent.setup();
  const box = await composer();
  // Typing 100 KB key by key is slow: paste it.
  await user.click(box);
  await user.paste(text);
  await user.keyboard("{Enter}");
  await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
  const run = must(fake.activeRun(t));
  await streaming(fake, run.run_id);
  return { user, runId: run.run_id };
}

const say = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("no message waits for the agent after its run ended (ac-1)", () => {
  // The server mirrors Pi's entries at `turn_end`: a run that ends before its first turn ended
  // never streams `entry.committed` for its prompt (after Stop the mirror is refused outright).
  const ends = {
    "Stop (run.interrupted, cancelled)": async (runId: string) => {
      await userEvent.setup().click(screen.getByRole("button", { name: "Stop" }));
      await waitFor(() => expect(fake.run(runId).status).toBe("cancelled"));
    },
    "run.completed": async (runId: string) => fake.agent.complete(runId),
    "run.failed": async (runId: string) => fake.agent.fail(runId, "start_failed", "No sandbox."),
    "run.budget_stopped": async (runId: string) => fake.agent.budgetStop(runId),
  };

  for (const [name, end] of Object.entries(ends)) {
    it(`${name} before Pi saved the prompt: the prompt stays, without the waiting note`, async () => {
      const t = threadWithHistory();
      openApp(fake, t);
      expect(await screen.findByText("a1")).toBeTruthy();
      const { runId } = await sendAndStart("draw a chart", t);
      expect(await screen.findByText(WAITING)).toBeTruthy();

      await end(runId);
      await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
      await waitFor(() => expect(screen.queryByText(WAITING)).toBeNull());
      expect(screen.getByText("draw a chart")).toBeTruthy();
      expect(screen.queryByText(/^Version/)).toBeNull();
    });
  }

  it("Stop after Pi saved the prompt and part of the answer keeps both, nothing waiting", async () => {
    const t = threadWithHistory();
    openApp(fake, t);
    expect(await screen.findByText("a1")).toBeTruthy();
    const { runId, user } = await sendAndStart("draw a chart", t);
    fake.agent.commitPrompt(runId);
    fake.agent.delta(runId, "m1", "Here is");
    expect(await screen.findByText(streamed("Here is"))).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(fake.run(runId).status).toBe("cancelled"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
    expect(screen.queryByText(WAITING)).toBeNull();
    expect(screen.getAllByText("draw a chart")).toHaveLength(1);
    expect(screen.queryByText(/^Version/)).toBeNull();
  });
});

describe("a prompt over 64 KiB reconciles with its stored entry (ac-2)", () => {
  // ~30k tokens, as the KOBE-285 compact-now spec sends: its entry is stored, but streamed
  // without a payload (`entry.committed` carries none over 64 KiB).
  const LONG = `Reply only with OK. ${Array.from({ length: 2400 }, (_, i) => `Entry ${i}: the harbour log notes the tide near the beacon.`).join(" ")}`;

  it("shows one copy of the prompt, no second version and nothing waiting, during and after the run", async () => {
    const t = threadWithHistory();
    openApp(fake, t);
    expect(await screen.findByText("a1")).toBeTruthy();
    const { runId } = await sendAndStart(LONG, t);
    expect(await screen.findByText(WAITING)).toBeTruthy();

    fake.agent.commitPrompt(runId);
    const committed = fake.run(runId).events.at(-1);
    expect(committed?.type).toBe("entry.committed");
    expect((committed?.payload as { payload?: unknown }).payload).toBeUndefined();
    // While the run goes on, the stored prompt replaces the copy shown from the send.
    await waitFor(() => expect(screen.queryByText(WAITING)).toBeNull());
    expect(screen.queryByText(/^Version/)).toBeNull();

    fake.agent.commit(runId, say("OK"), "m1");
    fake.agent.complete(runId);
    await waitFor(() => expect(announcement()).toBe("The agent finished."));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
    expect(await screen.findByText("OK")).toBeTruthy();
    expect(screen.queryByText(WAITING)).toBeNull();
    expect(screen.queryByText(/^Version/)).toBeNull();
    expect(screen.queryByText(/branches/)).toBeNull();
    expect(
      screen.getAllByText((_, el) => el?.textContent === LONG && el.children.length === 0),
    ).toHaveLength(1);
  });

  it("matches the server's tree after the run without a reload", async () => {
    const t = threadWithHistory();
    const first = openApp(fake, t);
    expect(await screen.findByText("a1")).toBeTruthy();
    const { runId } = await sendAndStart(LONG, t);
    fake.agent.commitPrompt(runId);
    fake.agent.commit(runId, say("OK"), "m1");
    fake.agent.complete(runId);
    expect(await screen.findByText("OK")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
    const live = must(document.querySelector('[data-kobe-scroll="messages"]')).textContent;

    first.unmount();
    openApp(fake, t);
    expect(await screen.findByText("OK")).toBeTruthy();
    expect(must(document.querySelector('[data-kobe-scroll="messages"]')).textContent).toBe(live);
  });
});
