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

/** A thread with one finished turn: "q1" → "a1". */
function threadWithHistory() {
  const t = fake.addThread("Sales");
  const u1 = fake.addEntry(t, null, { role: "user", content: "q1" });
  const a1 = fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "a1" }] });
  return { t, u1, a1 };
}

async function sendAndStart(text: string, t: string) {
  const user = userEvent.setup();
  await user.type(await composer(), `${text}{Enter}`);
  await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
  const run = must(fake.activeRun(t));
  await streaming(fake, run.run_id);
  return { user, runId: run.run_id };
}

describe("streaming a run (D16)", () => {
  it("shows the message at once, streams the answer and tool calls, and settles on the committed entries", async () => {
    const { t, a1 } = threadWithHistory();
    openApp(fake, t);
    expect(await screen.findByText("a1")).toBeTruthy();
    const { runId } = await sendAndStart("draw a chart", t);

    expect(screen.getByText("draw a chart")).toBeTruthy();
    const post = chatRequests(fake, "POST").find((r) => r.path.endsWith("/messages"));
    expect(post).toMatchObject({
      team: fake.teamId,
      idempotencyKey: "key-1",
      body: { content: "draw a chart" },
    });

    fake.agent.delta(runId, "m1", "Here is ");
    fake.agent.delta(runId, "m1", "the chart");
    expect(await screen.findByText("Here is the chart")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    fake.agent.toolCall(runId, "tc1", "bash", { cmd: "python plot.py" }, "m1");
    expect(await screen.findByText("Running…")).toBeTruthy();
    fake.agent.toolResult(runId, "tc1", "bash", "saved chart.png");
    expect(await screen.findByText("Done")).toBeTruthy();
    expect(screen.getByText("saved chart.png")).toBeTruthy();
    expect(screen.getByText(/python plot\.py/)).toBeTruthy();

    // Pi commits the prompt and the step; the entries replace the live copies.
    const u2 = fake.agent.commitPrompt(runId);
    fake.agent.commit(
      runId,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here is the chart" },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "python plot.py" } },
        ],
      },
      "m1",
    );
    fake.agent.commit(runId, {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "bash",
      content: [{ type: "text", text: "saved chart.png" }],
      isError: false,
    });
    fake.agent.complete(runId);

    await waitFor(() => expect(announcement()).toBe("The agent finished."));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
    expect(screen.getAllByText("Here is the chart")).toHaveLength(1);
    expect(screen.getAllByText("draw a chart")).toHaveLength(1);
    expect(fake.run(runId).parent_entry_id).toBe(a1);
    expect(u2).toBeTruthy();
    expect(fake.openStreams).toHaveLength(0);
  });

  it("shows a policy denial and a blocked domain clearly on the tool card", async () => {
    const { t } = threadWithHistory();
    openApp(fake, t);
    const { runId } = await sendAndStart("install it", t);
    fake.agent.toolCall(runId, "tc1", "mcp__jira__delete_issue", { key: "OPS-1" }, "m1");
    fake.emit(runId, "policy.denied", {
      tool_call_id: "tc1",
      tool: "mcp__jira__delete_issue",
      reasons: [
        {
          code: "team_deny_rule",
          stage: "team_deny",
          message: "Deleting Jira issues is not allowed in Finance.",
        },
      ],
    });
    fake.agent.toolCall(runId, "tc2", "bash", { cmd: "pip install pandas" }, "m1");
    fake.emit(runId, "egress.blocked", {
      domain: "pypi.org",
      tool_call_id: "tc2",
      request_access: true,
    });
    fake.emit(runId, "egress.blocked", { domain: "example.com", request_access: false });

    expect(await screen.findByText("Denied by policy")).toBeTruthy();
    expect(screen.getByText("Deleting Jira issues is not allowed in Finance.")).toBeTruthy();
    const denial = screen.getByText("Denied by policy.").closest('[role="note"]');
    expect(denial?.textContent).toContain("The tool did not run.");
    const blocked = await screen.findAllByText(/was blocked by your team/);
    expect(blocked.map((b) => b.textContent)).toEqual([
      expect.stringContaining("pypi.org"),
      expect.stringContaining("example.com"),
    ]);
  });

  it("Gate 1: a refresh mid-run resumes from the event log with no gaps or duplicates", async () => {
    const { t } = threadWithHistory();
    const first = openApp(fake, t);
    const { runId } = await sendAndStart("count to five", t);
    fake.agent.delta(runId, "m1", "one, ");
    fake.agent.delta(runId, "m1", "two, ");
    expect(await screen.findByText("one, two,")).toBeTruthy();

    first.unmount(); // the tab is refreshed while the run goes on server-side (U4)
    fake.agent.delta(runId, "m1", "three, ");
    expect(fake.openStreams).toHaveLength(0);

    openApp(fake, t);
    expect(await screen.findByText("one, two, three,")).toBeTruthy();
    // The prompt is back too (pending-messages), before Pi committed it.
    expect(screen.getByText("count to five")).toBeTruthy();
    const sse = fake.requests.filter((r) => r.method === "SSE");
    expect(sse.at(-1)?.path).toBe(`/v1/runs/${runId}/events?starting_after=0`);

    // A dropped connection: the browser reconnects with Last-Event-ID and the server even replays
    // two events the client already has.
    await streaming(fake, runId);
    must(fake.openStreams[0]).rewind(fake.run(runId).events.length - 2);
    fake.dropConnections();
    fake.agent.delta(runId, "m1", "four, ");
    fake.agent.delta(runId, "m1", "five");
    expect(await screen.findByText("one, two, three, four, five")).toBeTruthy();
    expect(screen.queryByText(/three, three/)).toBeNull();
    expect(fake.openStreams[0]?.connections).toBe(2);
  });

  it("a reload in the same tab resumes after what the entries hold instead of replaying", async () => {
    const { t } = threadWithHistory();
    const first = openApp(fake, t);
    const { runId } = await sendAndStart("two steps", t);
    fake.agent.commitPrompt(runId);
    fake.agent.toolCall(runId, "tc1", "bash", { cmd: "ls" }, "m1");
    fake.emit(runId, "policy.denied", {
      tool_call_id: "tc1",
      tool: "bash",
      reasons: [{ code: "team_deny_rule", stage: "team_deny", message: "No shell here." }],
    });
    fake.agent.commit(
      runId,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "ls" } }],
      },
      "m1",
    );
    expect(await screen.findByText("No shell here.")).toBeTruthy();
    const resumeAt = fake.run(runId).events.length;
    first.unmount();
    fake.agent.delta(runId, "m2", "step two");

    openApp(fake, t);
    expect(await screen.findByText("step two")).toBeTruthy();
    const sse = fake.requests.filter((r) => r.method === "SSE");
    expect(sse.at(-1)?.path).toBe(`/v1/runs/${runId}/events?starting_after=${resumeAt}`);
    // What the stream said before the resume point (the denial) is kept.
    expect(screen.getByText("No shell here.")).toBeTruthy();
    expect(screen.getAllByText("two steps")).toHaveLength(1);
  });

  it("shows Waking your workspace… until the agent starts working (D14)", async () => {
    const { t } = threadWithHistory();
    openApp(fake, t);
    const { runId } = await sendAndStart("hello", t);
    fake.emit(runId, "sandbox.waking", { reason: "hibernated" });
    expect(await screen.findByText("Waking your workspace…")).toBeTruthy();
    fake.agent.delta(runId, "m1", "Hi");
    await waitFor(() => expect(screen.queryByText("Waking your workspace…")).toBeNull());
  });
});

describe("queue, Steer and Stop (D17)", () => {
  it("Enter queues while a run is active; queued messages can be edited and deleted, and run in order", async () => {
    const { t } = threadWithHistory();
    openApp(fake, t);
    const { user, runId } = await sendAndStart("first", t);

    const box = await composer();
    await user.type(box, "second{Enter}");
    await user.type(box, "third{Enter}");
    const queue = await screen.findByRole("region", { name: "Queued messages" });
    await waitFor(() => expect(within(queue).getAllByRole("listitem")).toHaveLength(2));
    expect(within(queue).getByText("second")).toBeTruthy();
    expect(box.value).toBe("");
    const queued = [...fake.runs.values()].filter((r) => r.status === "queued");
    expect(queued.map((r) => r.input)).toEqual(["second", "third"]);

    // Edit the first queued message.
    await user.click(must(within(queue).getAllByRole("button", { name: "Edit" })[0]));
    const editor = within(queue).getByLabelText("Edit queued message 1");
    await user.clear(editor);
    await user.type(editor, "second, edited");
    await user.click(within(queue).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(must(queued[0]).input).toBe("second, edited"));
    expect(await within(queue).findByText("second, edited")).toBeTruthy();
    const patch = chatRequests(fake, "PATCH").at(-1);
    expect(patch).toMatchObject({
      path: `/v1/runs/${must(queued[0]).run_id}`,
      body: { content: "second, edited" },
    });

    // Delete the other one.
    await user.click(must(within(queue).getAllByRole("button", { name: "Delete" })[1]));
    await waitFor(() => expect(must(queued[1]).status).toBe("cancelled"));
    await waitFor(() => expect(within(queue).getAllByRole("listitem")).toHaveLength(1));

    // The active run ends: the queued message starts and streams.
    fake.agent.commitPrompt(runId);
    fake.agent.complete(runId);
    await streaming(fake, must(queued[0]).run_id);
    expect(fake.run(must(queued[0]).run_id).status).toBe("running");
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Queued messages" })).toBeNull(),
    );
    expect(screen.getByText("second, edited")).toBeTruthy();
    fake.agent.delta(must(queued[0]).run_id, "m1", "answer to the edit");
    expect(await screen.findByText("answer to the edit")).toBeTruthy();
  });

  it("Steer now injects into the running agent (button and Ctrl+Shift+Enter)", async () => {
    const { t } = threadWithHistory();
    openApp(fake, t);
    const { user, runId } = await sendAndStart("make a chart", t);
    const box = await composer();
    await user.type(box, "use a bar chart");
    await user.click(screen.getByRole("button", { name: "Steer now" }));
    await waitFor(() =>
      expect(chatRequests(fake, "POST").at(-1)).toMatchObject({
        path: `/v1/runs/${runId}/steer`,
        body: { content: "use a bar chart" },
      }),
    );
    expect(await screen.findByText("Steered: “use a bar chart”")).toBeTruthy();
    expect(box.value).toBe("");

    await user.type(box, "and label the axes{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    await waitFor(() =>
      expect(chatRequests(fake, "POST").at(-1)?.body).toEqual({ content: "and label the axes" }),
    );
    expect([...fake.runs.values()].filter((r) => r.status === "queued")).toHaveLength(0);
  });

  it("Stop pauses the queue and keeps the partial answer; Resume queue runs the held messages", async () => {
    const { t } = threadWithHistory();
    openApp(fake, t);
    const { user, runId } = await sendAndStart("long job", t);
    fake.agent.delta(runId, "m1", "Working on it");
    await user.type(await composer(), "next one{Enter}");
    await screen.findByRole("region", { name: "Queued messages" });

    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(fake.run(runId).status).toBe("cancelled"));
    expect(chatRequests(fake, "POST").some((r) => r.path === `/v1/runs/${runId}/cancel`)).toBe(
      true,
    );
    expect(await screen.findByText("Queue paused.")).toBeTruthy();
    const next = must([...fake.runs.values()].find((r) => r.input === "next one"));
    expect(next.status).toBe("queued");
    expect(screen.getByText("Working on it")).toBeTruthy(); // the partial answer stays
    expect(screen.getByText("Stopped.")).toBeTruthy();
    expect(fake.openStreams).toHaveLength(0); // a held queue isn't followed

    await user.click(screen.getByRole("button", { name: "Resume queue" }));
    await streaming(fake, next.run_id);
    expect(fake.run(next.run_id).status).toBe("running");
    expect(chatRequests(fake, "POST").some((r) => r.path === `/v1/threads/${t}/queue/resume`)).toBe(
      true,
    );
    await waitFor(() => expect(screen.queryByText("Queue paused.")).toBeNull());
  });

  it("with a server that doesn't hold the queue (KOBE-30), the next message starts after Stop", async () => {
    fake.pauseOnStop = false;
    const { t } = threadWithHistory();
    openApp(fake, t);
    const { user, runId } = await sendAndStart("long job", t);
    await user.type(await composer(), "next one{Enter}");
    await screen.findByRole("region", { name: "Queued messages" });
    await user.click(screen.getByRole("button", { name: "Stop" }));
    const next = must([...fake.runs.values()].find((r) => r.input === "next one"));
    await streaming(fake, next.run_id);
    await waitFor(() => expect(screen.queryByText("Queue paused.")).toBeNull());
    expect(fake.run(runId).status).toBe("cancelled");
  });

  it("sending while the queue is paused releases it", async () => {
    const { t } = threadWithHistory();
    openApp(fake, t);
    const { user } = await sendAndStart("long job", t);
    await user.type(await composer(), "held{Enter}");
    await screen.findByRole("region", { name: "Queued messages" });
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Queue paused.");
    await user.type(await composer(), "fresh{Enter}");
    const held = must([...fake.runs.values()].find((r) => r.input === "held"));
    await streaming(fake, held.run_id);
    await waitFor(() => expect(screen.queryByText("Queue paused.")).toBeNull());
  });

  it("Stop on its own keeps what streamed so far and says it stopped", async () => {
    const { t } = threadWithHistory();
    openApp(fake, t);
    const { user, runId } = await sendAndStart("long job", t);
    fake.agent.delta(runId, "m1", "Working on it");
    await screen.findByText("Working on it");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Stopped.")).toBeTruthy();
    expect(screen.getByText("Working on it")).toBeTruthy();
    expect(screen.getByText("long job")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
  });
});

describe("interrupted runs (D14)", () => {
  it("Gate 1: a sandbox killed mid-run leaves history intact and offers Retry, which runs first", async () => {
    const { t } = threadWithHistory();
    openApp(fake, t);
    const { user, runId } = await sendAndStart("analyse the CSV", t);
    fake.agent.commitPrompt(runId);
    fake.agent.delta(runId, "m1", "Reading the file");
    await user.type(await composer(), "then summarise{Enter}");
    await screen.findByRole("region", { name: "Queued messages" });

    fake.agent.loseSandbox(runId);
    expect(await screen.findByText("The run was interrupted")).toBeTruthy();
    expect(screen.getByText("a1")).toBeTruthy(); // history survives
    expect(screen.getByText("analyse the CSV")).toBeTruthy();
    expect(screen.getByText(/1 queued message waits/)).toBeTruthy();
    const queued = must([...fake.runs.values()].find((r) => r.input === "then summarise"));
    expect(queued.status).toBe("queued"); // the queue is held

    await user.click(await screen.findByRole("button", { name: "Retry from last entry" }));
    await waitFor(() => expect(fake.latestRun(t).retry_of_run_id).toBe(runId));
    const retry = fake.latestRun(t);
    await streaming(fake, retry.run_id);
    await waitFor(() => expect(screen.queryByText("The run was interrupted")).toBeNull());
    fake.agent.delta(retry.run_id, "m1", "Second attempt");
    expect(await screen.findByText("Second attempt")).toBeTruthy();
    expect(queued.status).toBe("queued");
  });

  it("offers Retry again after a reload, and Continue without retry resumes the queue", async () => {
    const { t } = threadWithHistory();
    const first = openApp(fake, t);
    const { user, runId } = await sendAndStart("risky", t);
    await user.type(await composer(), "afterwards{Enter}");
    await screen.findByRole("region", { name: "Queued messages" });
    fake.agent.loseSandbox(runId);
    await screen.findByText("The run was interrupted");
    first.unmount();

    openApp(fake, t);
    expect(await screen.findByText("The run was interrupted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry from last entry" })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue without retry" }));
    const queued = must([...fake.runs.values()].find((r) => r.input === "afterwards"));
    await waitFor(() => expect(queued.status).toBe("running"));
    await streaming(fake, queued.run_id);
    expect(chatRequests(fake, "POST").some((r) => r.path === `/v1/threads/${t}/queue/resume`)).toBe(
      true,
    );
  });
});

describe("branches: switch, edit and regenerate (D15)", () => {
  function branchedThread() {
    const t = fake.addThread("Branches");
    const u1 = fake.addEntry(t, null, { role: "user", content: "start" });
    const a1 = fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "a1" }] });
    const u2 = fake.addEntry(t, a1, { role: "user", content: "old question" });
    const a2 = fake.addEntry(t, u2, {
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
    });
    const u2b = fake.addEntry(t, a1, { role: "user", content: "new question" });
    const a2b = fake.addEntry(t, u2b, {
      role: "assistant",
      content: [{ type: "text", text: "new answer" }],
    });
    return { t, a1, a2, a2b };
  }

  it("shows the leaf's branch, switches with the branch picker and moves the leaf", async () => {
    const { t, a2 } = branchedThread();
    openApp(fake, t);
    expect(await screen.findByText("new answer")).toBeTruthy();
    expect(screen.queryByText("old answer")).toBeNull();
    expect(screen.getAllByText(/Version/)[0]?.textContent).toBe("Version 2 of 2");

    await userEvent
      .setup()
      .click(must(screen.getAllByRole("button", { name: "Previous version" })[0]));
    expect(await screen.findByText("old answer")).toBeTruthy();
    await waitFor(() =>
      expect(chatRequests(fake, "POST").at(-1)).toMatchObject({
        path: `/v1/threads/${t}/leaf`,
        body: { entry_id: a2 },
        team: fake.teamId,
      }),
    );
    expect(fake.threads.get(t)?.leaf_entry_id).toBe(a2);
  });

  it("edit-and-regenerate branches from the edited message's parent entry", async () => {
    const { t, a1 } = branchedThread();
    openApp(fake, t);
    const user = userEvent.setup();
    await screen.findByText("new answer");
    // The first message has no parent to branch from until root branching exists: its Edit is
    // shown unavailable, with the reason.
    const [first, second] = screen.getAllByRole("button", { name: "Edit" });
    expect(first?.getAttribute("aria-disabled")).toBe("true");
    expect(first?.getAttribute("title")).toMatch(/coming soon/);
    expect(
      document.getElementById(must(first?.getAttribute("aria-describedby")))?.textContent,
    ).toMatch(/coming soon/);
    await user.click(must(first));
    expect(screen.queryByLabelText("Edit your message")).toBeNull();
    expect(second?.getAttribute("aria-disabled")).toBeNull();
    await user.click(must(second));
    const editor = await screen.findByLabelText("Edit your message");
    await user.clear(editor);
    await user.type(editor, "third question");
    await user.click(within(must(editor.closest("form"))).getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(chatRequests(fake, "POST").find((r) => r.path.endsWith("/messages"))?.body).toEqual({
        content: "third question",
        parent_entry_id: a1,
      }),
    );
    const run = fake.latestRun(t);
    await streaming(fake, run.run_id);
    expect(screen.getByText("third question")).toBeTruthy();
    fake.agent.commitPrompt(run.run_id);
    fake.agent.commit(run.run_id, {
      role: "assistant",
      content: [{ type: "text", text: "third answer" }],
    });
    fake.agent.complete(run.run_id);
    expect(await screen.findByText("third answer")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByText(/Version/)[0]?.textContent).toBe("Version 3 of 3"),
    );
  });

  it("Regenerate re-sends the question as a new branch", async () => {
    const { t, a1 } = branchedThread();
    openApp(fake, t);
    await screen.findByText("new answer");
    const regenerate = screen.getAllByRole("button", { name: "Regenerate" });
    expect(regenerate.map((b) => b.getAttribute("aria-disabled"))).toEqual(["true", null]);
    await userEvent.setup().click(must(regenerate.at(-1)));
    await waitFor(() =>
      expect(chatRequests(fake, "POST").find((r) => r.path.endsWith("/messages"))?.body).toEqual({
        content: "new question",
        parent_entry_id: a1,
      }),
    );
  });
});
