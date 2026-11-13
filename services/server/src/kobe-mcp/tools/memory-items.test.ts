import { describe, expect, it } from "vitest";
import { allowedKobeTools, type KobeAccess } from "../access.js";
import { isWriteTool, type KobeTool } from "../catalog.js";
import { KOBE_ADMIN_TOOLS } from "./index.js";
import {
  KOBE_MEMORY_ITEM_TOOLS,
  MEMORY_ITEM_VERSIONS_MAX,
  MEMORY_ITEMS_PAGE_MAX,
} from "./memory-items.js";

/**
 * The read-only memory item tools (KOBE-650, v1.3 SMA15, Chris Q4): Workspace and Site items for
 * the people who curate them, never personal or portable items, never a write (ac-2), and no
 * author ids on Site items (KOBE-377 wall M6).
 */

const ID = "00000000-0000-4000-8000-000000000001";
const AUTHOR = "00000000-0000-4000-8000-000000000002";
const THREAD = "00000000-0000-4000-8000-000000000003";
const AT = "2026-11-13T10:00:00.000Z";

const tool = (name: string): KobeTool => {
  const t = KOBE_MEMORY_ITEM_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

const wireItem = (scope: string, extra: Record<string, unknown> = {}) => ({
  id: ID,
  scope,
  kind: "fact",
  status: "active",
  statement: "Deploys happen on Tuesdays.",
  tags: ["ops"],
  pinned: false,
  policy: false,
  as_of: null,
  owner_user_id: scope === "user" || scope === "portable" ? AUTHOR : null,
  superseded_by: null,
  version: 2,
  created_at: AT,
  updated_at: AT,
  updated_by: AUTHOR,
  ...extra,
});

const wireVersion = (version: number, scope: string) => ({
  version,
  statement: `Statement v${version}`,
  actor_user_id: AUTHOR,
  actor_kind: "user",
  lint_override: false,
  policy_override: false,
  source_thread_id: scope === "team" ? THREAD : null,
  source_entry_ids: null,
  created_at: AT,
});

const listBody = (scope: string, items: unknown[]) => ({
  scope,
  items,
  next_cursor: "abc_-1",
  usage: { count: items.length, max: 1000 },
});

const MEMORY_TOOL_NAMES = [
  "site_memory_item_get",
  "site_memory_items_list",
  "team_memory_item_get",
  "team_memory_items_list",
];

describe("the memory item tool set is read-only (ac-2)", () => {
  it("is exactly the four reads, each in the catalog", () => {
    expect(KOBE_MEMORY_ITEM_TOOLS.map((t) => t.name).sort()).toEqual(MEMORY_TOOL_NAMES);
    for (const t of KOBE_MEMORY_ITEM_TOOLS) expect(KOBE_ADMIN_TOOLS).toContain(t);
  });

  it("has no write tool: every one is read-only and only ever GETs", () => {
    expect(KOBE_MEMORY_ITEM_TOOLS.filter(isWriteTool)).toEqual([]);
    for (const t of KOBE_MEMORY_ITEM_TOOLS) {
      expect(t.readOnly, t.name).toBe(true);
      const sample = t.name.endsWith("_get") ? { id: ID } : {};
      expect(t.route(t.input.parse(sample)).method, t.name).toBe("GET");
    }
  });

  it("no catalog tool touches memory items except these reads", () => {
    const itemTools = KOBE_ADMIN_TOOLS.filter((t) => /memory_item/.test(t.name));
    expect(itemTools.map((t) => t.name).sort()).toEqual(MEMORY_TOOL_NAMES);
    // The other memory tools are the switch tools (KOBE-381), not item tools.
    const otherMemory = KOBE_ADMIN_TOOLS.filter(
      (t) => /memory/.test(t.name) && !/memory_item/.test(t.name),
    );
    expect(otherMemory.map((t) => t.name).sort()).toEqual(["team_memory_get", "team_memory_set"]);
  });

  it("needs the scope's curate permission", () => {
    expect(tool("team_memory_items_list")).toMatchObject({
      scope: "team",
      permission: "team.memory.curate",
    });
    expect(tool("team_memory_item_get")).toMatchObject({
      scope: "team",
      permission: "team.memory.curate",
    });
    expect(tool("site_memory_items_list")).toMatchObject({
      scope: "site",
      permission: "site.memory.curate",
    });
    expect(tool("site_memory_item_get")).toMatchObject({
      scope: "site",
      permission: "site.memory.curate",
    });
  });
});

describe("personal and portable items are never asked for or returned (ac-1)", () => {
  it("the input names no scope; each tool's route fixes team or site", () => {
    for (const t of KOBE_MEMORY_ITEM_TOOLS) {
      const sample = t.name.endsWith("_get") ? { id: ID } : {};
      expect(t.input.safeParse({ ...sample, scope: "user" }).success, t.name).toBe(false);
      const route = t.route(t.input.parse(sample));
      const scope = t.name.startsWith("team_") ? "team" : "site";
      if (t.name.endsWith("_get")) expect(route.path).toBe(`/memory/semantic/items/${scope}/${ID}`);
      else expect(route).toMatchObject({ path: "/memory/semantic/items", query: { scope } });
    }
  });

  it("a body of another scope is refused, not reduced", () => {
    const list = tool("team_memory_items_list");
    const get = tool("team_memory_item_get");
    for (const scope of ["user", "portable", "site"]) {
      expect(() => list.reduce(listBody(scope, [wireItem(scope)]), {})).toThrow();
      expect(() =>
        get.reduce({ ...wireItem(scope), versions: [wireVersion(1, scope)] }, { id: ID }),
      ).toThrow();
    }
    expect(() => tool("site_memory_items_list").reduce(listBody("portable", []), {})).toThrow();
  });
});

describe("list", () => {
  it("sends the filters to the console route, page bounded", () => {
    const t = tool("team_memory_items_list");
    expect(t.route(t.input.parse({}))).toEqual({
      method: "GET",
      path: "/memory/semantic/items",
      query: { scope: "team", status: "active", limit: String(MEMORY_ITEMS_PAGE_MAX) },
    });
    const input = t.input.parse({
      status: "archived",
      kind: "decision",
      query: "deploy",
      pinned: true,
      limit: 5,
      cursor: "abc_-1",
    });
    expect(t.route(input).query).toEqual({
      scope: "team",
      status: "archived",
      kind: "decision",
      q: "deploy",
      pinned: "true",
      limit: "5",
      cursor: "abc_-1",
    });
    expect(t.input.safeParse({ limit: MEMORY_ITEMS_PAGE_MAX + 1 }).success).toBe(false);
    // Policy is a Site filter only.
    expect(t.input.safeParse({ policy: true }).success).toBe(false);
    const site = tool("site_memory_items_list");
    expect(site.route(site.input.parse({ policy: true })).query).toMatchObject({
      scope: "site",
      policy: "true",
    });
  });

  it("filters a page by tag and keeps the route's cursor", () => {
    const t = tool("team_memory_items_list");
    const out = t.reduce(
      listBody("team", [wireItem("team"), wireItem("team", { id: AUTHOR, tags: ["billing"] })]),
      t.input.parse({ tag: "ops" }),
    ) as { items: { id: string }[]; next_cursor: string | null };
    expect(out.items.map((i) => i.id)).toEqual([ID]);
    expect(out.next_cursor).toBe("abc_-1");
  });

  it("Workspace items keep their author; Site items never carry author ids", () => {
    const team = tool("team_memory_items_list").reduce(listBody("team", [wireItem("team")]), {});
    expect(team).toMatchObject({ items: [{ updated_by: AUTHOR }] });
    const site = tool("site_memory_items_list").reduce(
      listBody("site", [wireItem("site", { policy: true })]),
      {},
    ) as { items: Record<string, unknown>[] };
    expect(site.items[0]).toMatchObject({ policy: true, statement: "Deploys happen on Tuesdays." });
    expect(JSON.stringify(site)).not.toContain(AUTHOR);
    expect(() => tool("site_memory_items_list").output.parse(site)).not.toThrow();
  });
});

describe("get", () => {
  it("returns the newest versions with provenance, at most ten", () => {
    const t = tool("team_memory_item_get");
    const versions = Array.from({ length: 14 }, (_, i) => wireVersion(14 - i, "team"));
    const out = t.reduce({ ...wireItem("team", { version: 14 }), versions }, { id: ID }) as {
      versions: { version: number; actor_user_id: string; source_thread_id: string | null }[];
      versions_total: number;
    };
    expect(out.versions).toHaveLength(MEMORY_ITEM_VERSIONS_MAX);
    expect(out.versions[0]).toMatchObject({
      version: 14,
      actor_user_id: AUTHOR,
      source_thread_id: THREAD,
    });
    expect(out.versions_total).toBe(14);
    expect(() => t.output.parse(out)).not.toThrow();
  });

  it("Site provenance has no author ids and no thread links", () => {
    const t = tool("site_memory_item_get");
    const out = t.reduce(
      { ...wireItem("site"), versions: [wireVersion(2, "site"), wireVersion(1, "site")] },
      { id: ID },
    );
    expect(JSON.stringify(out)).not.toContain(AUTHOR);
    expect(JSON.stringify(out)).not.toContain("source_thread_id");
    expect(out).toMatchObject({ versions: [{ version: 2, actor_kind: "user" }, { version: 1 }] });
    expect(() => t.output.parse(out)).not.toThrow();
  });
});

describe("who lists them", () => {
  const base: KobeAccess = {
    mode: "admin",
    level: "read",
    teamRole: "member",
    memorySteward: false,
    siteRole: null,
    grants: [],
  };
  const memoryNames = (access: KobeAccess) =>
    allowedKobeTools(access)
      .map((t) => t.name)
      .filter((n) => /memory_item/.test(n))
      .sort();

  it("curators of each scope, and nobody else", () => {
    expect(memoryNames(base)).toEqual([]);
    expect(memoryNames({ ...base, teamRole: "contributor" })).toEqual([]);
    expect(memoryNames({ ...base, teamRole: "team_admin" })).toEqual([
      "team_memory_item_get",
      "team_memory_items_list",
    ]);
    // A Workspace memory steward of any role.
    expect(memoryNames({ ...base, memorySteward: true })).toEqual([
      "team_memory_item_get",
      "team_memory_items_list",
    ]);
    // A Site memory steward (grant) and a Site admin read Site items.
    expect(memoryNames({ ...base, grants: ["memory_steward"] })).toEqual([
      "site_memory_item_get",
      "site_memory_items_list",
    ]);
    expect(memoryNames({ ...base, siteRole: "admin" })).toEqual([
      "site_memory_item_get",
      "site_memory_items_list",
    ]);
    // A steward who left the Workspace gets nothing; the switches still apply.
    expect(memoryNames({ ...base, memorySteward: true, teamRole: null })).toEqual([]);
    expect(memoryNames({ ...base, siteRole: "admin", level: "docs" })).toEqual([]);
  });
});
