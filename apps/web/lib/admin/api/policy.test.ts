import { afterEach, describe, expect, it, vi } from "vitest";
import { must } from "../../testing/must";
import * as install from "./install/policy";
import * as team from "./team/policy";

function stub(status: number, body?: unknown) {
  const fetchFn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}
afterEach(() => vi.unstubAllGlobals());

const RULE = {
  id: "r-1",
  scope: "install",
  scope_ref: null,
  effect: "deny",
  tool_glob: "mcp__github__*",
  arg_pattern: { "/repo_name": "secret-*" },
  note: "No GitHub",
  created_by: "u",
  created_at: "2026-10-01T10:00:00Z",
  expires_at: null,
};

describe("install policy floor API", () => {
  it("lists rules camelized, keeping arg pattern pointers", async () => {
    const fetchFn = stub(200, { rules: [RULE] });
    const res = await install.listInstallRules();
    expect(res).toMatchObject({
      ok: true,
      data: [{ toolGlob: "mcp__github__*", argPattern: { "/repo_name": "secret-*" } }],
    });
    expect(must(fetchFn.mock.calls[0])[0]).toBe("/v1/install/policy/rules");
  });

  it("creates with the strict snake_case body", async () => {
    const fetchFn = stub(201, { rule: RULE });
    await install.createInstallRule({
      effect: "ask",
      toolGlob: "bash",
      note: null,
      expiresAt: null,
    });
    const [url, init] = must(fetchFn.mock.calls[0]);
    expect(url).toBe("/v1/install/policy/rules");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      effect: "ask",
      tool_glob: "bash",
      note: null,
      expires_at: null,
    });
  });

  it("deletes and reads/writes settings", async () => {
    let fetchFn = stub(204);
    await install.deleteInstallRule("r 1");
    expect(must(fetchFn.mock.calls[0])[0]).toBe("/v1/install/policy/rules/r%201");
    fetchFn = stub(200, { promptSandboxWrites: true });
    await install.putPolicySettings({ promptSandboxWrites: true });
    const [url, init] = must(fetchFn.mock.calls[0]);
    expect([url, init?.method, init?.body]).toEqual([
      "/v1/install/policy/settings",
      "PUT",
      '{"promptSandboxWrites":true}',
    ]);
  });
});

describe("team policy API", () => {
  it("names the team on every call", async () => {
    for (const call of [
      () => team.listTeamRules("t-1"),
      () =>
        team.createTeamRule("t-1", {
          effect: "allow",
          toolGlob: "read",
          note: null,
          expiresAt: null,
        }),
      () => team.deleteTeamRule("t-1", "r-1"),
    ]) {
      const fetchFn = stub(200, { rules: [], rule: RULE });
      await call();
      expect(new Headers(must(fetchFn.mock.calls[0])[1]?.headers).get("x-kobe-team")).toBe("t-1");
    }
  });
});
