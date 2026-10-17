// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { openApp } from "./testing";

/**
 * KOBE-276 ac-1 (chat side): on your own thumbs down, "Share as an eval case…" opens a preview of
 * exactly what the agent's owner gets; earlier turns, tool outputs and file names are added only
 * when ticked; nothing is shared until Share (with the preview's digest); Withdraw deletes it.
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

/** Two answers; the second rated down by the member with a reason and a comment. */
function ratedThread() {
  const thread = fake.addThread("Numbers");
  const u1 = fake.addEntry(thread, null, ask("What is 2+2?"));
  const a1 = fake.addEntry(thread, u1, say("Four."));
  const u2 = fake.addEntry(thread, a1, ask("And 3+3?"));
  fake.addEntry(thread, u2, say("Seven."));
  const r1 = fake.addEndedRun(thread, u1);
  const r2 = fake.addEndedRun(thread, u2);
  fake.feedback.set(r1, {
    run_id: r1,
    thread_id: thread,
    entry_id: null,
    rating: "up",
    reasons: [],
    comment: null,
    updated_at: "2026-10-16T09:00:00.000Z",
  });
  fake.feedback.set(r2, {
    run_id: r2,
    thread_id: thread,
    entry_id: null,
    rating: "down",
    reasons: ["wrong"],
    comment: "3+3 is six.",
    updated_at: "2026-10-16T09:00:00.000Z",
  });
  fake.evalCaseAvailable.set(r2, {
    earlier_exchanges: 1,
    tool_outputs: [{ id: "call-1", tool: "calculator", is_error: false }],
    attachments: [
      {
        id: "f0000000-0000-4000-8000-000000000001",
        name: "sums.csv",
        mime_type: "text/csv",
        size_bytes: 12,
      },
    ],
  });
  return { thread, r1, r2 };
}

const caseRequests = (method: string) =>
  fake.requests.filter((r) => r.method === method && r.path.includes("eval-case"));

describe("sharing a thumbs down as an eval case (KOBE-276)", () => {
  it("previews exactly what is shared, adds only what is ticked, and shares on Share", async () => {
    const x = ratedThread();
    const user = userEvent.setup();
    openApp(fake, x.thread);
    // Only the rated-down answer offers it.
    const offer = await screen.findByRole("button", { name: "Share as an eval case…" });
    expect(screen.getAllByRole("button", { name: "Share as an eval case…" })).toHaveLength(1);
    await user.click(offer);
    const dialog = await screen.findByRole("dialog", { name: "Share as an eval case" });
    const shown = within(dialog).getByRole("region", { name: "What will be shared" });
    await waitFor(() => expect(within(shown).getByText("Seven, it said.")).toBeTruthy());
    expect(within(shown).getByText("Thumbs down · Wrong or made up · 3+3 is six.")).toBeTruthy();
    expect(within(shown).queryByText(/Output of/)).toBeNull();
    expect(within(shown).queryByText("sums.csv")).toBeNull();
    // A preview only: nothing shared yet; the first preview asks for nothing extra.
    expect(caseRequests("POST").map((r) => [r.path, r.body])).toEqual([
      [
        `/v1/runs/${x.r2}/eval-case/preview`,
        { earlier_exchanges: 0, tool_output_ids: [], attachment_ids: [] },
      ],
    ]);
    expect(fake.evalCases.size).toBe(0);

    const tool = within(dialog).getByRole("checkbox", { name: /Tool output 1: calculator/ });
    expect((tool as HTMLInputElement).checked).toBe(false);
    await user.click(tool);
    await waitFor(() => expect(within(shown).getByText("Output of call-1")).toBeTruthy());
    await user.selectOptions(within(dialog).getByLabelText("Earlier exchanges"), "1");
    await waitFor(() => expect(within(shown).getByText("Earlier prompt 1")).toBeTruthy());
    expect(fake.evalCases.size).toBe(0);

    await user.click(within(dialog).getByRole("button", { name: "Share" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const share = caseRequests("POST").find((r) => r.path === `/v1/runs/${x.r2}/eval-case`);
    expect(share?.body).toEqual({
      earlier_exchanges: 1,
      tool_output_ids: ["call-1"],
      attachment_ids: [],
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(fake.evalCases.get(x.r2)).toMatchObject({
      content: { tool_outputs: [{ tool: "calculator" }], attachments: [] },
    });
    expect(await screen.findByText("Shared with the agent's owner as an eval case.")).toBeTruthy();
  });

  it("shares nothing on Cancel, and withdraws a shared case", async () => {
    const x = ratedThread();
    const user = userEvent.setup();
    openApp(fake, x.thread);
    await user.click(await screen.findByRole("button", { name: "Share as an eval case…" }));
    const dialog = await screen.findByRole("dialog", { name: "Share as an eval case" });
    await waitFor(() => expect(within(dialog).getByText("Seven, it said.")).toBeTruthy());
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.evalCases.size).toBe(0);
    expect(caseRequests("POST").every((r) => r.path.endsWith("/preview"))).toBe(true);

    await user.click(screen.getByRole("button", { name: "Share as an eval case…" }));
    const again = await screen.findByRole("dialog", { name: "Share as an eval case" });
    await waitFor(() => expect(within(again).getByText("Seven, it said.")).toBeTruthy());
    await user.click(within(again).getByRole("button", { name: "Share" }));
    const withdraw = await screen.findByRole("button", { name: "Withdraw" });
    const id = fake.evalCases.get(x.r2)?.id as string;
    await user.click(withdraw);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Share as an eval case…" })).toBeTruthy(),
    );
    expect(fake.evalCases.size).toBe(0);
    expect(fake.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toContain(
      `/v1/eval-cases/${id}`,
    );
  });

  it("is not offered on a thread shared with you, and reads a shared case back on reload", async () => {
    const x = ratedThread();
    const thread = fake.threads.get(x.thread);
    if (thread) Object.assign(thread, { read_only: true, visibility: "team", owner_name: "Ann" });
    const app = openApp(fake, x.thread);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Bad answer" }).length).toBe(2),
    );
    expect(screen.queryByRole("button", { name: "Share as an eval case…" })).toBeNull();
    app.unmount();
    if (thread) Object.assign(thread, { read_only: false, visibility: "private" });
    fake.evalCases.set(x.r2, { id: "c0000000-0000-4000-8000-000000000001" });
    openApp(fake, x.thread);
    expect(await screen.findByText("Shared with the agent's owner as an eval case.")).toBeTruthy();
  });
});
