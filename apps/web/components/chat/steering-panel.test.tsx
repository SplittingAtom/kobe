// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { browserSpaced, chatRequests, composer, openApp, streaming } from "./testing";

/**
 * The steering panel (CE10, KOBE-206) over the fake server. There is no browser e2e suite (no
 * Playwright; the bash e2e drives the API only), so the walk through all five states is this
 * component-level state machine test.
 */
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

const panel = () => must(document.querySelector<HTMLElement>("[data-kobe-steering]"));
const mode = () => panel().dataset.state;
const phase = () => panel().querySelector("[data-phase]")?.textContent;
const queueRegion = () => within(panel()).getByRole("region", { name: "Queued messages" });
const queuedTexts = () =>
  within(queueRegion())
    .getAllByRole("listitem")
    .map((li) => li.querySelector("button[title]")?.textContent);

function thread() {
  const t = fake.addThread("Steering");
  const u1 = fake.addEntry(t, null, { role: "user", content: "q1" });
  fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "a1" }] });
  return t;
}

async function startRun(t: string, text = "first") {
  const user = userEvent.setup();
  await user.type(await composer(), `${text}{Enter}`);
  await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
  const runId = must(fake.activeRun(t)).run_id;
  await streaming(fake, runId);
  return { user, runId };
}

async function queue(user: ReturnType<typeof userEvent.setup>, ...texts: string[]) {
  for (const text of texts) await user.type(await composer(), `${text}{Enter}`);
  await waitFor(() => expect(queuedTexts()).toEqual(texts));
}

describe("the five states (ac-1)", () => {
  it("walks idle → active → queued → waiting → interrupted", async () => {
    const t = thread();
    openApp(fake, t);
    await screen.findByText("a1");

    // Idle: zero height (collapsed grid row, nothing inside, inert).
    expect(mode()).toBe("idle");
    expect(panel().className).toContain("grid-rows-[0fr]");
    expect(must(panel().firstElementChild).childElementCount).toBe(0);
    expect(must(panel().firstElementChild).hasAttribute("inert")).toBe(true);

    // Active: status (model, elapsed, phase) and controls.
    const { user, runId } = await startRun(t);
    await waitFor(() => expect(mode()).toBe("active"));
    expect(phase()).toBe("Thinking");
    expect(within(panel()).getByText(/^\d+:\d\d(:\d\d)?$/)).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Steer now" })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Stop" })).toBeTruthy();
    fake.agent.toolCall(runId, "tc1", "bash", { cmd: "ls" }, "m1");
    await waitFor(() => expect(phase()).toBe("Running tool bash"));
    fake.agent.toolResult(runId, "tc1", "bash", "ok");
    await waitFor(() => expect(phase()).toBe("Thinking"));

    // Queued: Stop with a message behind the run holds the queue; nothing runs.
    await queue(user, "second");
    await user.click(within(panel()).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(mode()).toBe("queued"));
    expect(within(panel()).getByText("Queue paused.")).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: "Stop" })).toBeNull();

    // Waiting: resume; the next run asks for approval. The card stays in the thread.
    await user.click(within(panel()).getByRole("button", { name: "Resume queue" }));
    const next = must([...fake.runs.values()].find((r) => r.input === "second"));
    await streaming(fake, next.run_id);
    await waitFor(() => expect(mode()).toBe("active"));
    fake.agent.toolCall(next.run_id, "tc2", "write_file", { path: "x" }, "m2");
    fake.requestApproval(next.run_id, {
      approval_id: "00000000-0000-4000-8000-000900000001",
      tool_call_id: "tc2",
      tool: "write_file",
      input: { path: "x" },
      risk: "write",
      reasons: [{ code: "risk_write", stage: "risk_class", message: "Writes a file." }],
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await waitFor(() => expect(mode()).toBe("waiting"));
    expect(phase()).toBe("Waiting for your approval");
    const card = await screen.findByRole("group", { name: /Approval needed/ });
    expect(panel().contains(card)).toBe(false);

    // Interrupted: Retry and Continue, no Steer.
    fake.agent.loseSandbox(next.run_id);
    await waitFor(() => expect(mode()).toBe("interrupted"));
    expect(within(panel()).getByText("The run was interrupted")).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Retry from last entry" })).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Continue without retry" })).toBeTruthy();
    expect(within(panel()).queryByRole("button", { name: "Steer now" })).toBeNull();
  });

  it("goes back to zero height when the run ends", async () => {
    const t = thread();
    openApp(fake, t);
    const { runId } = await startRun(t);
    await waitFor(() => expect(mode()).toBe("active"));
    fake.agent.commitPrompt(runId);
    fake.agent.complete(runId);
    await waitFor(() => expect(mode()).toBe("idle"));
    expect(must(panel().firstElementChild).childElementCount).toBe(0);
  });

  it("works at 390 px: the panel sits in the composer footer, above the input", async () => {
    resizeWindow(390);
    const t = thread();
    openApp(fake, t);
    await startRun(t);
    await waitFor(() => expect(mode()).toBe("active"));
    const footer = must(document.querySelector("[data-kobe-composer]"));
    expect(footer.contains(panel())).toBe(true);
    const input = await composer();
    expect(panel().compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(panel()).getByRole("button", { name: "Stop" })).toBeTruthy();
    resizeWindow(DESKTOP_WIDTH);
  });
});

describe("queue chips (ac-2)", () => {
  it("click edits, × deletes, through the queue routes", async () => {
    const t = thread();
    openApp(fake, t);
    const { user } = await startRun(t);
    await queue(user, "second", "third");
    const [second, third] = [...fake.runs.values()].filter((r) => r.status === "queued");

    await user.click(within(queueRegion()).getByRole("button", { name: /^Edit queued message 1/ }));
    const editor = within(queueRegion()).getByLabelText("Edit queued message 1");
    await user.clear(editor);
    await user.type(editor, "second, edited");
    await user.click(within(queueRegion()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(queuedTexts()).toEqual(["second, edited", "third"]));
    expect(chatRequests(fake, "PATCH").at(-1)).toMatchObject({
      path: `/v1/runs/${must(second).run_id}`,
      body: { content: "second, edited" },
    });

    await user.click(
      within(queueRegion()).getByRole("button", { name: "Delete queued message 2" }),
    );
    await waitFor(() => expect(queuedTexts()).toEqual(["second, edited"]));
    expect(must(third).status).toBe("cancelled");
  });

  it("reorders by keyboard on the grip (arrows, Home, End)", async () => {
    const t = thread();
    openApp(fake, t);
    const { user } = await startRun(t);
    await queue(user, "a", "b", "c");
    const ids = new Map([...fake.runs.values()].map((r) => [r.input, r.run_id]));

    within(queueRegion()).getByRole("button", { name: "Move queued message 3" }).focus();
    await user.keyboard("{Home}");
    await waitFor(() => expect(queuedTexts()).toEqual(["c", "a", "b"]));
    const order = chatRequests(fake, "POST").filter((r) => r.path.endsWith("/queue/order"));
    expect(order.at(-1)?.body).toEqual({ run_ids: [ids.get("c"), ids.get("a"), ids.get("b")] });
    // Focus follows the chip (keyed by run), so the next key moves it again.
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Move queued message 1"),
    );
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(queuedTexts()).toEqual(["a", "c", "b"]));
    await user.keyboard("{End}");
    await waitFor(() => expect(queuedTexts()).toEqual(["a", "b", "c"]));
    expect([...fake.runs.values()].filter((r) => r.status === "queued").length).toBe(3);
  });

  it("reorders by dragging the grip (pointer events)", async () => {
    const t = thread();
    openApp(fake, t);
    const { user } = await startRun(t);
    await queue(user, "a", "b", "c");
    const chips = within(queueRegion()).getAllByRole("listitem");
    chips.forEach((chip, i) => {
      chip.getBoundingClientRect = () =>
        ({
          left: i * 100,
          width: 80,
          top: 0,
          height: 24,
          right: i * 100 + 80,
          bottom: 24,
        }) as DOMRect;
    });
    const grip = within(queueRegion()).getByRole("button", { name: "Move queued message 1" });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 40 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 250 });
    // While dragging the chips show the drop order.
    expect(queuedTexts()).toEqual(["b", "c", "a"]);
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 250 });
    await waitFor(() => expect(queuedTexts()).toEqual(["b", "c", "a"]));
    const order = chatRequests(fake, "POST").filter((r) => r.path.endsWith("/queue/order"));
    expect(order).toHaveLength(1);
  });

  it("a stale order (409 queue_changed) shows the error and reads the queue again", async () => {
    const t = thread();
    openApp(fake, t);
    const { user } = await startRun(t);
    await queue(user, "a", "b");
    // Another tab deletes "a" behind this one's back.
    must([...fake.runs.values()].find((r) => r.input === "a")).status = "cancelled";
    within(queueRegion()).getByRole("button", { name: "Move queued message 2" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(await screen.findByText("The queue changed meanwhile.")).toBeTruthy();
    await waitFor(() => expect(queuedTexts()).toEqual(["b"]));
  });

  it("pauses and resumes the queue while a run is on", async () => {
    const t = thread();
    openApp(fake, t);
    const { user, runId } = await startRun(t);
    await queue(user, "later");
    await user.click(within(panel()).getByRole("button", { name: "Pause the queue" }));
    expect(await within(panel()).findByText(/^Queue paused: these wait/)).toBeTruthy();
    // KOBE-269: the queue's chips and notes sit flush, without the browser's list indent.
    expect(browserSpaced(panel())).toEqual([]);
    expect(chatRequests(fake, "POST").some((r) => r.path === `/v1/threads/${t}/queue/pause`)).toBe(
      true,
    );
    // The run ends; the paused message waits.
    fake.agent.commitPrompt(runId);
    fake.agent.complete(runId);
    await waitFor(() => expect(mode()).toBe("queued"));
    const later = must([...fake.runs.values()].find((r) => r.input === "later"));
    expect(later.status).toBe("queued");
    await user.click(within(panel()).getByRole("button", { name: "Resume queue" }));
    await streaming(fake, later.run_id);
    expect(later.status).toBe("running");
  });
});

describe("composer and controls (ac-3)", () => {
  it("the primary button reads Queue during a run; Steer now sends the typed text as a steer", async () => {
    const t = thread();
    openApp(fake, t);
    expect(await screen.findByRole("button", { name: "Send" })).toBeTruthy();
    const { user, runId } = await startRun(t);
    expect(await screen.findByRole("button", { name: "Queue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

    const steer = within(panel()).getByRole("button", { name: "Steer now" });
    expect(steer.getAttribute("aria-disabled")).toBe("true"); // nothing typed yet
    expect(steer.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+Enter Meta+Shift+Enter");
    const box = await composer();
    await user.type(box, "use a bar chart");
    await user.click(steer);
    await waitFor(() =>
      expect(chatRequests(fake, "POST").at(-1)).toMatchObject({
        path: `/v1/runs/${runId}/steer`,
        body: { content: "use a bar chart" },
      }),
    );
    expect(box.value).toBe("");
  });

  it("keeps what the member typed while a queued message was still being sent, not the sent text (KOBE-415)", async () => {
    // The queue read that ends a send can be held, so the member types on while it is in flight.
    let holds = false;
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const plain = fake.fetch;
    const holding: typeof fetch = async (input, init) => {
      if (holds && String(input).endsWith("/pending-messages")) await held;
      return plain(input, init);
    };
    Object.defineProperty(fake, "fetch", { value: holding });
    const t = thread();
    openApp(fake, t);
    const { user } = await startRun(t);
    holds = true;
    const box = await composer();
    await user.type(box, "ALPHA{Enter}");
    await waitFor(() =>
      expect(chatRequests(fake, "POST").at(-1)).toMatchObject({ body: { content: "ALPHA" } }),
    );
    expect(box.value).toBe("ALPHA"); // still being sent: the queue read is held
    await user.type(box, " BRAVO");
    release();
    // The send ends: the sent text and its joining space go, what was typed after it stays.
    await waitFor(() => expect(box.value).toBe("BRAVO"));
    expect(queuedTexts()).toEqual(["ALPHA"]);
    await user.type(box, "{Enter}");
    await waitFor(() => expect(queuedTexts()).toEqual(["ALPHA", "BRAVO"]));
    expect(box.value).toBe("");
  });

  it("Ctrl/Cmd+Shift+Enter steers from the composer", async () => {
    const t = thread();
    openApp(fake, t);
    const { user, runId } = await startRun(t);
    const box = await composer();
    await user.type(box, "faster{Meta>}{Shift>}{Enter}{/Shift}{/Meta}");
    await waitFor(() =>
      expect(chatRequests(fake, "POST").at(-1)).toMatchObject({
        path: `/v1/runs/${runId}/steer`,
        body: { content: "faster" },
      }),
    );
    expect([...fake.runs.values()].filter((r) => r.status === "queued")).toHaveLength(0);
  });

  it("Retry from last entry and Continue without retry work from the panel", async () => {
    const t = thread();
    openApp(fake, t);
    const { user, runId } = await startRun(t);
    await queue(user, "after");
    fake.agent.loseSandbox(runId);
    await waitFor(() => expect(mode()).toBe("interrupted"));
    expect(within(panel()).getByText(/1 queued message waits/)).toBeTruthy();
    await user.click(within(panel()).getByRole("button", { name: "Retry from last entry" }));
    await waitFor(() => expect(fake.latestRun(t).retry_of_run_id).toBe(runId));
    const retry = fake.latestRun(t);
    await streaming(fake, retry.run_id);
    await waitFor(() => expect(mode()).toBe("active"));

    fake.agent.loseSandbox(retry.run_id);
    await waitFor(() => expect(mode()).toBe("interrupted"));
    await user.click(within(panel()).getByRole("button", { name: "Continue without retry" }));
    const after = must([...fake.runs.values()].find((r) => r.input === "after"));
    await streaming(fake, after.run_id);
    expect(after.status).toBe("running");
  });

  it("shows Finishing on budget while a run goes on with the budget used up", async () => {
    const t = thread();
    openApp(fake, t);
    await screen.findByText("a1");
    // The server lets the in-flight run finish its step (D30); the panel reads the status.
    fake.budgetStatus = { state: "exhausted", lines: [] };
    await startRun(t);
    await waitFor(() => expect(phase()).toBe("Finishing on budget"));
  });
});

describe("review round 1", () => {
  it("a retry waiting in the queue stays first after a reorder", async () => {
    const t = thread();
    openApp(fake, t);
    const { user } = await startRun(t);
    await queue(user, "a");
    fake.queueRetry(t, "retry");
    await user.type(await composer(), "b{Enter}"); // the send reads the queue again
    await waitFor(() => expect(queuedTexts()).toEqual(["retry", "a", "b"]));
    within(queueRegion()).getByRole("button", { name: "Move queued message 3" }).focus();
    await user.keyboard("{Home}");
    await waitFor(() => expect(queuedTexts()).toEqual(["retry", "b", "a"]));
    const order = chatRequests(fake, "POST").filter((r) => r.path.endsWith("/queue/order"));
    expect((order.at(-1)?.body as { run_ids: string[] }).run_ids).toHaveLength(3);
    // The server's answer is applied: no extra read of the queue after a reorder.
    const reads = () => fake.requests.filter((r) => r.path.endsWith("/pending-messages")).length;
    const before = reads();
    await new Promise((r) => setTimeout(r, 50));
    expect(reads()).toBe(before);
  });

  it("a drag whose run left the queue meanwhile drops nothing", async () => {
    const t = thread();
    openApp(fake, t);
    const { user } = await startRun(t);
    await queue(user, "a", "b", "c");
    const chips = within(queueRegion()).getAllByRole("listitem");
    chips.forEach((chip, i) => {
      chip.getBoundingClientRect = () =>
        ({
          left: i * 100,
          width: 80,
          top: 0,
          height: 24,
          right: i * 100 + 80,
          bottom: 24,
        }) as DOMRect;
    });
    const grip = within(queueRegion()).getByRole("button", { name: "Move queued message 1" });
    fireEvent.pointerDown(grip, { pointerId: 1, button: 0, clientX: 40 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 250 });
    // "c" (the drop target) is deleted from another tab; this tab reads the queue again.
    must([...fake.runs.values()].find((r) => r.input === "c")).status = "cancelled";
    await user.type(await composer(), "d{Enter}");
    await waitFor(() => expect(queuedTexts()).toEqual(["a", "b", "d"]));
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 250 });
    expect(chatRequests(fake, "POST").some((r) => r.path.endsWith("/queue/order"))).toBe(false);
  });

  it("a reader never sees Finishing on budget (the budget read is the viewer's own)", async () => {
    const t = thread();
    const first = openApp(fake, t);
    await startRun(t);
    first.unmount();
    must(fake.threads.get(t)).read_only = true;
    fake.budgetStatus = { state: "exhausted", lines: [] };
    openApp(fake, t);
    await waitFor(() => expect(phase()).toBe("Thinking"));
    expect(
      fake.requests.some((r) => r.path === "/v1/team/budgets/status" && r.method === "GET"),
    ).toBe(true); // the notices' banner reads it; the panel doesn't use it for a reader
    expect(within(panel()).queryByRole("button", { name: "Stop" })).toBeNull();
  });
});
