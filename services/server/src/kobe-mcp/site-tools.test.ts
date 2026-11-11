import { describe, expect, it } from "vitest";
import { allowedKobeTools, type KobeAccess } from "./access.js";
import { routeCaller } from "./execute.js";
import type { KobeRouteAnswer, KobeTool, KobeWriteTool } from "./catalog.js";
import { kobeToolByName } from "./tools/index.js";
import { KOBE_SITE_TOOLS } from "./tools/site/index.js";
import { auditTarget, siteAuditList } from "./tools/site/reads.js";
import { KOBE_SITE_SAMPLES } from "../testing/kobe-site-samples.js";

/** The Site console tools (KOBE-622): who lists them, their routes, before-states and results. */

const base: KobeAccess = {
  mode: "admin",
  level: "read_write",
  teamRole: "team_admin",
  siteRole: null,
  grants: [],
};
const names = (access: KobeAccess) =>
  allowedKobeTools(access)
    .filter((t) => t.scope === "site")
    .map((t) => t.name)
    .sort();
const ID = "00000000-0000-4000-8000-000000000001";

function tool(name: string): KobeTool {
  const t = kobeToolByName(name);
  if (t === undefined) throw new Error(name);
  return t;
}
const write = (name: string) => tool(name) as KobeWriteTool;
const answering = (status: number, body: unknown) => (): Promise<KobeRouteAnswer> =>
  Promise.resolve({ status, body });

describe("who lists the site tools (ac-1, ac-2, ac-4)", () => {
  it("a team admin without a site role lists none", () => {
    expect(names(base)).toEqual([]);
  });

  it("a Skill reviewer lists only the reviewer actions", () => {
    expect(names({ ...base, teamRole: "member", grants: ["skill_reviewer"] })).toEqual([
      "site_skill_reviews_claim",
      "site_skill_reviews_comment",
      "site_skill_reviews_decide",
      "site_skill_reviews_list",
    ]);
  });

  it("a site admin lists every site tool; the switches still apply", () => {
    const admin = { ...base, siteRole: "admin" as const };
    expect(names(admin)).toEqual(KOBE_SITE_TOOLS.map((t) => t.name).sort());
    expect(names({ ...admin, mode: "docs" })).toEqual([]);
    expect(names({ ...admin, mode: "off" })).toEqual([]);
    expect(names({ ...admin, level: "docs" })).toEqual([]);
    expect(names({ ...admin, level: "read" })).toEqual(
      KOBE_SITE_TOOLS.filter((t) => t.readOnly)
        .map((t) => t.name)
        .sort(),
    );
    // A site admin who is no longer a member of the run's team gets nothing there.
    expect(names({ ...admin, teamRole: null })).toEqual([]);
  });
});

describe("site tool definitions", () => {
  it.each(KOBE_SITE_TOOLS.map((t) => [t.name, t] as const))(
    "%s: strict input, a sample, a /site route",
    (name, t) => {
      expect(t.scope).toBe("site");
      expect(t.input.safeParse({ ...(KOBE_SITE_SAMPLES[name] as object), extra: 1 }).success).toBe(
        false,
      );
      const input = t.input.parse(KOBE_SITE_SAMPLES[name]);
      expect(t.route(input).path.startsWith("/site/")).toBe(true);
      if (!t.readOnly) expect((t as KobeWriteTool).summary(input).length).toBeGreaterThan(5);
    },
  );

  it("names no KA8 console-only action", () => {
    const paths = KOBE_SITE_TOOLS.map((t) => t.route(t.input.parse(KOBE_SITE_SAMPLES[t.name])));
    for (const r of paths) {
      expect(r.path).not.toMatch(/break-glass|legal-hold|retention|transfer-ownership|isolation/);
      expect(r.path).not.toMatch(/^\/site\/roles\/[0-9a-f-]+$/);
      expect(r.path).not.toMatch(/^\/site\/settings/);
    }
    // No tool deletes a user, a team, a connector, a model or a ceiling domain.
    const deletes = KOBE_SITE_TOOLS.map(
      (t) => [t.name, t.route(t.input.parse(KOBE_SITE_SAMPLES[t.name]))] as const,
    )
      .filter(([, r]) => r.method === "DELETE")
      .map(([n]) => n)
      .sort();
    expect(deletes).toEqual([
      "site_grants_take",
      "site_invites_revoke",
      "site_skill_blocklist_remove",
    ]);
  });

  it("change tools need a before-state for every changed value", () => {
    const t = tool("site_budget_set");
    expect(t.input.safeParse({ change: { from: {}, to: { daily_usd: 5 } } }).success).toBe(false);
    expect(t.input.safeParse({ change: { from: { daily_usd: 1 }, to: {} } }).success).toBe(false);
    expect(
      t.input.safeParse({ change: { from: { daily_usd: 1 }, to: { daily_usd: 5 } } }).success,
    ).toBe(true);
  });

  it("writes send the approved before-state as the route's condition (L3)", () => {
    const route = (name: string) => {
      const t = tool(name);
      return t.route(t.input.parse(KOBE_SITE_SAMPLES[name]));
    };
    expect(route("site_users_deactivate").body).toEqual({ expectedState: "active" });
    expect(route("site_connectors_set_status").body).toEqual({
      status: "disabled",
      expectedStatus: "active",
    });
    expect(route("site_egress_ceiling_set").body).toEqual({
      in_ceiling: false,
      expected_in_ceiling: true,
    });
    expect(route("site_budget_set").body).toEqual({ daily_usd: 10, expected: { daily_usd: null } });
    expect(route("site_branding_set").body).toEqual({
      showName: false,
      expected: { showName: true },
    });
    expect(route("site_models_catalog_update").body).toEqual({
      label: "Fast",
      expected: { label: null },
    });
  });
});

describe("before-states", () => {
  it("deactivation: same, changed, or user_not_found", async () => {
    const t = write("site_users_deactivate");
    const input = { user_id: ID, from_state: "active" };
    const users = (deactivatedAt: string | null) =>
      answering(200, {
        users: [
          {
            id: ID,
            name: "A",
            email: "a@x",
            siteRole: "user",
            twoFactorEnabled: false,
            deactivatedAt,
          },
        ],
      });
    expect(await t.before(input, users(null))).toBe("same");
    expect(await t.before(input, users("2026-01-01T00:00:00.000Z"))).toBe("changed");
    expect(await t.before(input, answering(200, { users: [] }))).toMatchObject({
      code: "user_not_found",
    });
  });

  it("a connector's status, and a missing connector", async () => {
    const t = write("site_connectors_set_status");
    const input = { connector_id: ID, from_status: "active", to_status: "disabled" };
    const connector = (status: string) =>
      answering(200, {
        connector: {
          id: ID,
          name: "c",
          url: "https://c.example",
          authKind: "none",
          credentialSource: "member",
          status,
          toolCount: 1,
          driftedCount: 0,
        },
      });
    expect(await t.before(input, connector("active"))).toBe("same");
    expect(await t.before(input, connector("disabled"))).toBe("changed");
    expect(await t.before(input, answering(404, {}))).toMatchObject({
      code: "connector_not_found",
    });
  });

  it("grants: give needs it not held, take needs it held", async () => {
    const grants = (held: boolean) =>
      answering(200, {
        grants: held
          ? [
              {
                userId: ID,
                name: "R",
                email: "r@x",
                grant: "skill_reviewer",
                grantedAt: "2026-01-01T00:00:00.000Z",
                deactivated: false,
              },
            ]
          : [],
      });
    const input = { user_id: ID, grant: "skill_reviewer" };
    expect(await write("site_grants_give").before(input, grants(false))).toBe("same");
    expect(await write("site_grants_give").before(input, grants(true))).toBe("changed");
    expect(await write("site_grants_take").before(input, grants(true))).toBe("same");
    expect(await write("site_grants_take").before(input, grants(false))).toBe("changed");
  });
});

describe("audit reads never carry IP or user agent (ac-3)", () => {
  it("copies allowlisted fields only and strips IP/UA-like keys from targets", () => {
    const out = siteAuditList.reduce(
      {
        events: [
          {
            id: ID,
            seq: 7,
            at: "2026-01-01T00:00:00.000Z",
            teamId: null,
            actor: { kind: "user", id: ID, name: "A", email: "a@x" },
            action: "auth.sign_in",
            target: { userId: ID, ip: "10.0.0.1", nested: { userAgent: "curl", ok: 1 } },
            ip: "10.0.0.1",
            userAgent: "Mozilla/5.0",
            prevHash: "x",
            hash: "y",
          },
        ],
        nextCursor: "7",
      },
      {},
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain("10.0.0.1");
    expect(text).not.toContain("Mozilla");
    expect(text).not.toContain("curl");
    expect(siteAuditList.output.parse(out)).toMatchObject({
      events: [{ seq: 7, target: { userId: ID, nested: { ok: 1 } } }],
      next_cursor: "7",
    });
    expect(auditTarget({ IP_Address: "x", user_agent: "y", keep: "z" })).toEqual({ keep: "z" });
  });

  it("pages the log through the route's own keyset cursor, at most 50", () => {
    const r = siteAuditList.route(siteAuditList.input.parse({ cursor: "120", limit: 10 }));
    expect(r.query).toEqual({ limit: "10", before: "120" });
    expect(siteAuditList.input.safeParse({ limit: 51 }).success).toBe(false);
  });
});

describe("the executor's paths", () => {
  it("accepts domain segments, refuses dot segments", async () => {
    const seen: string[] = [];
    const api = {
      request: (url: string) => {
        seen.push(url);
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    };
    const call = routeCaller(api as never, {
      userId: ID,
      teamId: ID,
      runId: ID,
      threadId: ID,
      toolCallId: "t",
    });
    await call({ method: "PUT", path: "/site/egress-ceiling/*.example.com" });
    await call({ method: "GET", path: "/site/audit", query: { limit: "5", action: "a.b" } });
    expect(seen).toEqual([
      "/v1/site/egress-ceiling/*.example.com",
      "/v1/site/audit?limit=5&action=a.b",
    ]);
    await expect(call({ method: "GET", path: "/site/./users" })).rejects.toThrow();
    await expect(call({ method: "GET", path: "/site/../team" })).rejects.toThrow();
    await expect(call({ method: "GET", path: "/site/users?x=1" })).rejects.toThrow();
  });
});
