// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
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
