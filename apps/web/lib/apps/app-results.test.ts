import { describe, expect, it, vi } from "vitest";
import { listAppResults, readAppResult, textReason } from "./app-results";

const T = "11111111-1111-4111-8111-111111111111";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("app results client (KOBE-438)", () => {
  it("lists the thread's results for the viewer", async () => {
    const fetchFn = vi.fn(async () =>
      json(200, {
        results: [{ result_ref: "r", tool_call_id: "tc", view: "text", reason: "no_access" }],
        truncated: false,
      }),
    );
    const res = await listAppResults(T, T, fetchFn);
    expect(res).toMatchObject({
      ok: true,
      data: { results: [{ resultRef: "r", toolCallId: "tc", reason: "no_access" }] },
    });
    expect((fetchFn.mock.calls[0] as unknown[] | undefined)?.[0]).toBe(
      `/v1/threads/${T}/app-results`,
    );
  });

  it("reads a stored result raw, with its keys as the upstream sent them", async () => {
    const result = { structuredContent: { table_name: "t" } };
    const fetchFn = vi.fn(async () => json(200, { input: { q: "t" }, result }));
    expect(await readAppResult(T, "r", T, fetchFn)).toEqual({
      ok: true,
      input: { q: "t" },
      result,
    });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("x-kobe-team")).toBe(T);
    expect(await readAppResult(T, "r", T, async () => json(409, { code: "text_only" }))).toEqual({
      ok: false,
      code: "text_only",
    });
  });

  it("says why a card is text", () => {
    expect(textReason({ reason: "no_access", connectorName: "Catalyst" })).toBe(
      "Connect Catalyst to use this app.",
    );
    expect(textReason({ reason: "template_changed", connectorName: "x" })).toBe(
      "This app changed and is waiting for review.",
    );
  });
});
