import { describe, expect, it, vi } from "vitest";
import { apiRequest, errorKind } from "./client";
import { TEAM_HEADER } from "../teams";
import { must } from "../testing/must";

function respond(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
  );
}

describe("apiRequest", () => {
  it("GETs same-origin JSON and camelizes keys", async () => {
    const fetchFn = respond(200, { owner_user_id: "u", nested: [{ created_at: "x" }] });
    const res = await apiRequest("/v1/x", { fetchFn });
    expect(res).toEqual({
      ok: true,
      status: 200,
      data: { ownerUserId: "u", nested: [{ createdAt: "x" }] },
    });
    const [url, init] = must(fetchFn.mock.calls[0]);
    expect(url).toBe("/v1/x");
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin" });
  });

  it("sends JSON bodies as given (wire casing) and the team header when asked", async () => {
    const fetchFn = respond(204);
    const res = await apiRequest("/v1/team/members/u1", {
      method: "PATCH",
      json: { role: "builder" },
      teamId: "t-1",
      fetchFn,
    });
    expect(res).toEqual({ ok: true, status: 204, data: undefined });
    const init = must(must(fetchFn.mock.calls[0])[1]);
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get(TEAM_HEADER)).toBe("t-1");
    expect(init.body).toBe('{"role":"builder"}');
  });

  it("refuses absolute or protocol-relative URLs (API calls stay on this origin)", async () => {
    const fetchFn = respond(200, {});
    await expect(apiRequest("https://evil.example/v1/x", { fetchFn })).rejects.toThrow();
    await expect(apiRequest("//evil.example/v1/x", { fetchFn })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("passes the server's message through for 4xx", async () => {
    const res = await apiRequest("/v1/x", {
      fetchFn: respond(409, {
        code: "last_team_admin",
        message: "A team needs at least one team admin.",
      }),
    });
    expect(res).toEqual({
      ok: false,
      error: {
        status: 409,
        code: "last_team_admin",
        message: "A team needs at least one team admin.",
      },
    });
  });

  it.each([
    [
      401,
      { code: "unauthenticated", message: "Sign in to continue." },
      "unauthenticated",
      /sign in/i,
    ],
    [403, { code: "forbidden" }, "forbidden", /permission/i],
    [404, undefined, "not_found", /not found/i],
    [500, { code: "boom", message: "stack trace: secret" }, "server_error", /HTTP 500/],
  ])("maps HTTP %i to a friendly error", async (status, body, code, message) => {
    const res = await apiRequest("/v1/x", { fetchFn: respond(status, body) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe(code);
    expect(res.error.message).toMatch(message);
    expect(res.error.message).not.toMatch(/secret/);
  });

  it("keeps the isolation_runtime_missing 503 recognisable", async () => {
    const res = await apiRequest("/v1/x", {
      fetchFn: respond(503, {
        code: "isolation_runtime_missing",
        message: "Isolation runtime missing: agents are disabled.",
      }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({ status: 503, code: "isolation_runtime_missing" });
    expect(errorKind(res.error)).toBe("isolation");
  });

  it("reports a network failure without throwing", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const res = await apiRequest("/v1/x", { fetchFn });
    expect(res).toMatchObject({ ok: false, error: { status: 0, code: "network_error" } });
  });

  it("tolerates a non-JSON error body", async () => {
    const fetchFn = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const res = await apiRequest("/v1/x", { fetchFn });
    expect(res).toMatchObject({ ok: false, error: { status: 502, code: "server_error" } });
  });
});

describe("errorKind", () => {
  it.each([
    [{ status: 401, code: "unauthenticated" }, "signIn"],
    [{ status: 403, code: "forbidden" }, "forbidden"],
    [{ status: 403, code: "not_a_team_member" }, "forbidden"],
    [{ status: 409, code: "no_active_team" }, "chooseTeam"],
    [{ status: 409, code: "team_mismatch" }, "reload"],
    [{ status: 404, code: "not_found" }, "notFound"],
    [{ status: 503, code: "isolation_runtime_missing" }, "isolation"],
    [{ status: 409, code: "slug_taken" }, "other"],
  ] as const)("%j → %s", (error, kind) => {
    expect(errorKind({ ...error, message: "" })).toBe(kind);
  });
});
