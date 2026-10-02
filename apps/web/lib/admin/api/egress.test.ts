import { afterEach, describe, expect, it, vi } from "vitest";
import { must } from "../../testing/must";
import * as install from "./install/egress";
import * as team from "./team/egress";

function stub(status: number, body?: unknown) {
  const fetchFn = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}
afterEach(() => vi.unstubAllGlobals());

const ENTRY = {
  domain: "*.example.com",
  preset: null,
  in_ceiling: true,
  shared_hosting: false,
  note: null,
  created_by: "u",
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
};

describe("install egress ceiling API", () => {
  it("reads the ceiling camelized", async () => {
    stub(200, { domains: [ENTRY], presets: ["package_registries"] });
    const res = await install.getEgressCeiling();
    expect(res).toMatchObject({ ok: true, data: { domains: [{ inCeiling: true }] } });
  });

  it("adds with a snake_case body and URL-encodes wildcard domains", async () => {
    let fetchFn = stub(201, { domain: ENTRY });
    await install.addCeilingDomain("*.example.com", null);
    let [url, init] = must(fetchFn.mock.calls[0]);
    expect(url).toBe("/v1/install/egress-ceiling");
    expect(JSON.parse(String(init?.body))).toEqual({ domain: "*.example.com", note: null });

    fetchFn = stub(200, { domain: ENTRY });
    await install.setCeilingMembership("*.example.com", false);
    [url, init] = must(fetchFn.mock.calls[0]);
    expect(url).toBe("/v1/install/egress-ceiling/*.example.com");
    expect(JSON.parse(String(init?.body))).toEqual({ in_ceiling: false });

    fetchFn = stub(204);
    await install.deleteCeilingDomain("a b.com");
    expect(must(fetchFn.mock.calls[0])[0]).toBe("/v1/install/egress-ceiling/a%20b.com");

    fetchFn = stub(200, { domains: [], presets: [] });
    await install.setPresetMembership("git_hosts", true);
    expect(must(fetchFn.mock.calls[0])[0]).toBe("/v1/install/egress-ceiling/presets/git_hosts");
  });
});

describe("team egress API", () => {
  it("lists, enables and disables with the team header", async () => {
    let fetchFn = stub(200, {
      domains: [
        {
          domain: "pypi.org",
          preset: "package_registries",
          in_ceiling: true,
          shared_hosting: false,
          enabled: false,
          enabled_by: null,
          enabled_at: null,
        },
      ],
    });
    const res = await team.listTeamEgress("t-1");
    expect(res).toMatchObject({ ok: true, data: [{ domain: "pypi.org", inCeiling: true }] });
    expect(new Headers(must(fetchFn.mock.calls[0])[1]?.headers).get("x-kobe-team")).toBe("t-1");

    fetchFn = stub(201, { domain: "pypi.org", enabled: true });
    await team.enableTeamDomain("t-1", "pypi.org");
    expect(must(fetchFn.mock.calls[0])[0]).toBe("/v1/team/egress/domains/pypi.org");
    expect(must(fetchFn.mock.calls[0])[1]?.method).toBe("PUT");

    fetchFn = stub(204);
    await team.disableTeamDomain("t-1", "pypi.org");
    expect(must(fetchFn.mock.calls[0])[1]?.method).toBe("DELETE");
  });
});
