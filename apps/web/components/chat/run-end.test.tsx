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

  it("reads the thread for a body-less prompt only, not for large answers or tool outputs", async () => {
    const t = threadWithHistory();
    openApp(fake, t);
    expect(await screen.findByText("a1")).toBeTruthy();
    const { runId } = await sendAndStart(LONG, t);
    const reads = () =>
      fake.requests.filter(
        (r) =>
          r.method === "GET" &&
          r.path.startsWith(`/v1/threads/${t}?`) &&
          r.path.includes("limit=500"),
      ).length;
    const before = reads();
    fake.agent.commitPrompt(runId);
    await waitFor(() => expect(reads()).toBe(before + 1));
    await waitFor(() => expect(screen.queryByText(WAITING)).toBeNull());

    const big = "x".repeat(70_000);
    fake.agent.commit(
      runId,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "cat" } }],
      },
      "m1",
    );
    fake.agent.commit(runId, {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "bash",
      content: [{ type: "text", text: big }],
      isError: false,
    });
    fake.agent.commit(runId, say(big), "m2");
    expect(
      (fake.run(runId).events.at(-1)?.payload as { payload?: unknown }).payload,
    ).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads()).toBe(before + 1);
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

describe("after a reload, the prompt of a run that ended before Pi's first turn (KOBE-290)", () => {
  // The server keeps the prompt in the thread's entries (Pi's own entry, or its own when Pi never
  // received it, with a `ku-` id) and binds it to the run (`user_entry_id`), so a reload reads it.
  const ends = {
    "Stop (cancelled)": async (runId: string) => {
      await userEvent.setup().click(screen.getByRole("button", { name: "Stop" }));
      await waitFor(() => expect(fake.run(runId).status).toBe("cancelled"));
    },
    "a failed start": async (runId: string) =>
      fake.agent.fail(runId, "start_failed", "No sandbox."),
    "a budget stop": async (runId: string) => fake.agent.budgetStop(runId),
  };

  for (const [name, end] of Object.entries(ends)) {
    it(`${name}: the reloaded prompt shows once, as sent, never waiting`, async () => {
      const t = threadWithHistory();
      const answer = must(fake.threads.get(t)?.leaf_entry_id);
      openApp(fake, t);
      expect(await screen.findByText("a1")).toBeTruthy();
      const { runId } = await sendAndStart("draw a chart", t);
      await end(runId);
      await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
      const status = fake.run(runId).status;

      // What the server stored at the run's end.
      const prompt = fake.addEntry(t, answer, {
        role: "user",
        content: [{ type: "text", text: "draw a chart" }],
      });
      if (status === "budget_stopped") {
        fake.threadMarkers.set(t, {
          runs: [{ run_id: runId, status, user_entry_id: prompt, parent_entry_id: answer }],
          approvals: [],
        });
      }
      cleanup();
      openApp(fake, t);
      expect(await screen.findByText("draw a chart")).toBeTruthy();
      expect(screen.getAllByText("draw a chart")).toHaveLength(1);
      expect(screen.queryByText(WAITING)).toBeNull();
      expect(screen.queryByText(/^Version/)).toBeNull();
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
      if (status === "budget_stopped") {
        expect(await screen.findByText("Run stopped by the budget")).toBeTruthy();
      }
    });
  }
});
