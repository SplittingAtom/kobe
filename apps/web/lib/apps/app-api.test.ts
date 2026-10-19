import { describe, expect, it, vi } from "vitest";
import { appFrameUrl, callAppTool, listAppTools } from "./app-api";

const APP = "a".repeat(64);
const TEAM = "11111111-1111-4111-8111-111111111111";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("app API (KOBE-437)", () => {
  it("calls the MA-4 endpoint with the team header and keeps the result's keys as sent", async () => {
    const result = { structuredContent: { snake_case: 1 }, content: [] };
    const fetchFn = vi.fn(async () => json(200, { result }));
    expect(await callAppTool(APP, TEAM, "preview_table", { table: "t" }, fetchFn)).toEqual({
      ok: true,
      result,
    });
    const [path, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/v1/team/apps/${APP}/calls`);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("x-kobe-team")).toBe(TEAM);
    expect(JSON.parse(init.body as string)).toEqual({
      tool: "preview_table",
      arguments: { table: "t" },
    });
  });

  it("passes the server's refusal code and message, and a fixed one otherwise", async () => {
    const refused = json(403, { error: { code: "tool_not_read_only", message: "Read only." } });
    expect(await callAppTool(APP, TEAM, "x", {}, async () => refused)).toEqual({
      ok: false,
      code: "tool_not_read_only",
      message: "Read only.",
    });
    expect(
      await callAppTool(APP, TEAM, "x", {}, async () => new Response("<html>", { status: 502 })),
    ).toMatchObject({ ok: false, code: "call_failed" });
    expect(
      await callAppTool(APP, TEAM, "x", {}, async () => {
        throw new TypeError("offline");
      }),
    ).toMatchObject({ ok: false, code: "network_error" });
  });

  it("lists the app's tools", async () => {
    const fetchFn = vi.fn(async () => json(200, { tools: [{ name: "t", input_schema: {} }] }));
    expect(await listAppTools(APP, TEAM, fetchFn)).toEqual({
      ok: true,
      tools: [{ name: "t", input_schema: {} }],
    });
    expect((fetchFn.mock.calls[0] as unknown[] | undefined)?.[0]).toBe(
      `/v1/team/apps/${APP}/tools`,
    );
  });

  it("builds the frame route's URL for the team and the bytes", () => {
    expect(appFrameUrl(APP, TEAM, "b".repeat(64))).toBe(
      `/v1/team/apps/${APP}/frame?team=${TEAM}&sha256=${"b".repeat(64)}`,
    );
    expect(() => appFrameUrl("../x", TEAM, "b".repeat(64))).toThrow();
  });
});
