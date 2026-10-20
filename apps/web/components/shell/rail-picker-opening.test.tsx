// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { ThreadOnScreenContext, useThreadSettled } from "../chat/thread-on-screen";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenedPicker, openingOf } from "./rail-picker-opening";

/** KOBE-460 fix: a rail picker's opening call, once per mount, StrictMode included. */
const TEAM = "00000000-0000-4000-8000-000100000001";
const THREAD = "00000000-0000-4000-8000-000200000001";
const APP = {
  appId: "b".repeat(64),
  connectorId: "11111111-1111-4111-8111-111111111111",
  connectorName: "Catalyst",
  tool: "open_picker",
  title: "Lakehouse Picker",
  sha256: "e".repeat(64),
};
const ok = () =>
  new Response(JSON.stringify({ result: { content: [{ type: "text", text: "catalogs" }] } }), {
    status: 200,
  });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OpenedPicker", () => {
  it("calls the opening tool once under StrictMode and hands the result on", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(ok()));
    vi.stubGlobal("fetch", fetchFn);
    const onAnswer = vi.fn();
    render(
      <StrictMode>
        <OpenedPicker app={APP} teamId={TEAM} threadId={THREAD} ready onAnswer={onAnswer}>
          {(result) => <p>opened {JSON.stringify(result)}</p>}
        </OpenedPicker>
      </StrictMode>,
    );
    expect(screen.getByRole("status").textContent).toBe("Opening Lakehouse Picker…");
    expect(await screen.findByText(/opened .*catalogs/)).toBeTruthy();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [path, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/v1/team/apps/${APP.appId}/calls`);
    expect(JSON.parse(String(init.body))).toEqual({
      tool: "open_picker",
      arguments: {},
      thread_id: THREAD,
    });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0]?.[1]).toBe(THREAD);
  });

  it("waits, calling nothing, until the thread on screen is settled", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(ok()));
    vi.stubGlobal("fetch", fetchFn);
    const view = render(
      <OpenedPicker app={APP} teamId={TEAM} threadId={null} ready={false} onAnswer={() => {}}>
        {() => <p>opened</p>}
      </OpenedPicker>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchFn).not.toHaveBeenCalled();
    view.rerender(
      <OpenedPicker app={APP} teamId={TEAM} threadId={THREAD} ready onAnswer={() => {}}>
        {() => <p>opened</p>}
      </OpenedPicker>,
    );
    expect(await screen.findByText("opened")).toBeTruthy();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("reads a network failure and an isError result as a failed open", async () => {
    expect(openingOf({ ok: false, code: "network_error", message: "down" })).toEqual({
      kind: "failed",
      code: "network_error",
      message: "down",
    });
    expect(openingOf({ ok: true, result: { isError: true } }).kind).toBe("failed");
    expect(openingOf({ ok: true, result: { content: [] } })).toEqual({
      kind: "open",
      result: { content: [] },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    render(
      <OpenedPicker app={APP} teamId={TEAM} threadId={null} ready onAnswer={() => {}}>
        {() => <p>opened</p>}
      </OpenedPicker>,
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Retry"));
    expect(screen.getByText(/Lakehouse Picker could not be opened/)).toBeTruthy();
  });
});

const THREAD_B = "00000000-0000-4000-8000-000200000002";
const result = (text: string) =>
  new Response(JSON.stringify({ result: { content: [{ type: "text", text }] } }), {
    status: 200,
  });
const refused = (code: string) =>
  new Response(JSON.stringify({ error: { code, message: `refused: ${code}` } }), { status: 403 });

/** A fetch whose answers the test gives, one per call, in any order. */
function heldFetch() {
  const answers: ((r: Response) => void)[] = [];
  const fetchFn = vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve)));
  vi.stubGlobal("fetch", fetchFn);
  return { fetchFn, answer: (n: number, r: Response) => must(answers[n])(r) };
}
const must = <T,>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing");
  return v;
};
const bodyOf = (fetchFn: ReturnType<typeof vi.fn>, n: number) =>
  JSON.parse(
    String((fetchFn.mock.calls[n] as unknown as [string, RequestInit])[1].body),
  ) as unknown;

function picker(threadId: string | null, onAnswer = vi.fn()) {
  return (
    <OpenedPicker app={APP} teamId={TEAM} threadId={threadId} ready onAnswer={onAnswer}>
      {(r) => <p>opened {JSON.stringify(r)}</p>}
    </OpenedPicker>
  );
}

describe("OpenedPicker and the thread on screen (review MEDIUM-1, LOW-2)", () => {
  it("re-opens for the new thread when it changes in flight; the stale answer never arrives", async () => {
    const { fetchFn, answer } = heldFetch();
    const onAnswer = vi.fn();
    const view = render(picker(THREAD, onAnswer));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    view.rerender(picker(THREAD_B, onAnswer));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetchFn, 1)).toMatchObject({ thread_id: THREAD_B });
    answer(1, result("for B"));
    expect(await screen.findByText(/opened .*for B/)).toBeTruthy();
    answer(0, result("for A"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/for A/)).toBeNull();
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0]?.[1]).toBe(THREAD_B);
  });

  it("a connector off in thread A does not leave a bare Retry on thread B: it opens for B", async () => {
    const { fetchFn, answer } = heldFetch();
    const view = render(picker(THREAD));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    answer(0, refused("connector_off"));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    view.rerender(picker(THREAD_B));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Opening Lakehouse Picker…");
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    answer(1, result("for B"));
    expect(await screen.findByText(/opened .*for B/)).toBeTruthy();
  });

  it("an open picker is not re-opened by a thread change", async () => {
    const { fetchFn, answer } = heldFetch();
    const view = render(picker(THREAD));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    answer(0, result("for A"));
    expect(await screen.findByText(/opened .*for A/)).toBeTruthy();
    view.rerender(picker(THREAD_B));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/opened .*for A/)).toBeTruthy();
  });
});

function Settled({ runtime, ms }: { readonly runtime: string | null; readonly ms?: number }) {
  return <p>{useThreadSettled(runtime, ms) ? "settled" : "waiting"}</p>;
}

describe("useThreadSettled (review MEDIUM-2, LOW-2)", () => {
  it("is settled with no chat app around, or once the runtime shows the thread asked for", () => {
    const view = render(<Settled runtime={null} />);
    expect(screen.getByText("settled")).toBeTruthy();
    view.rerender(
      <ThreadOnScreenContext value={THREAD}>
        <Settled runtime={null} />
      </ThreadOnScreenContext>,
    );
    expect(screen.getByText("waiting")).toBeTruthy();
    view.rerender(
      <ThreadOnScreenContext value={THREAD}>
        <Settled runtime={THREAD} />
      </ThreadOnScreenContext>,
    );
    expect(screen.getByText("settled")).toBeTruthy();
  });

  it("stops waiting after a bounded time (a thread that never loads)", async () => {
    render(
      <ThreadOnScreenContext value={THREAD}>
        <Settled runtime={null} ms={40} />
      </ThreadOnScreenContext>,
    );
    expect(screen.getByText("waiting")).toBeTruthy();
    expect(await screen.findByText("settled")).toBeTruthy();
  });

  it("waits a few seconds by default", async () => {
    const { THREAD_SETTLE_MS } = await import("../chat/thread-on-screen");
    expect(THREAD_SETTLE_MS).toBeGreaterThanOrEqual(2_000);
    expect(THREAD_SETTLE_MS).toBeLessThanOrEqual(5_000);
  });
});
