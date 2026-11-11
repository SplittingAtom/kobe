import { describe, expect, it } from "vitest";
import { KOBE_PAGE_MAX, decodeCursor, encodeCursor, page } from "./catalog.js";
import { kobePinnedTool } from "./pinned.js";
import { KOBE_ADMIN_TOOLS } from "./tools/index.js";
import { teamMembersSetRole } from "./tools/team-members.js";

describe("Kobe MCP catalog (KOBE-619)", () => {
  it("names every tool <area>_<verb>, with strict inputs and a console permission", () => {
    const names = KOBE_ADMIN_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of KOBE_ADMIN_TOOLS) {
      expect(tool.name).toMatch(/^[a-z]+(_[a-z]+)+$/);
      expect(tool.permission.startsWith(`${tool.scope}.`)).toBe(true);
      expect(tool.input.safeParse({ unexpected: 1 }).success).toBe(false);
    }
  });

  it("annotates reads read-only and writes as closed-world writes", () => {
    for (const tool of KOBE_ADMIN_TOOLS) {
      const pinned = kobePinnedTool("kobe-builtin", tool);
      expect(pinned.pi_name).toBe(`mcp__kobe_builtin__${tool.name}`);
      expect(pinned.annotations.readOnlyHint).toBe(tool.readOnly);
      expect(pinned.annotations.openWorldHint).toBe(false);
      expect(pinned.input_schema.type).toBe("object");
    }
  });

  it("pages at most 50 rows with an opaque cursor", () => {
    const rows = Array.from({ length: 120 }, (_, i) => i);
    const first = page(rows, undefined);
    expect(first.rows).toHaveLength(KOBE_PAGE_MAX);
    const second = page(rows, first.next_cursor);
    expect(second.rows[0]).toBe(50);
    const last = page(rows, second.next_cursor);
    expect(last.rows).toHaveLength(20);
    expect(last.next_cursor).toBeUndefined();
    expect(decodeCursor("garbage!")).toBe(0);
    expect(decodeCursor(encodeCursor(7))).toBe(7);
  });

  it("checks a role change's before-state against the members the person reads", async () => {
    const input = {
      user_id: "00000000-0000-4000-8000-000000000001",
      from_role: "member" as const,
      to_role: "team_admin" as const,
    };
    const members = (role: string) => () =>
      Promise.resolve({
        status: 200,
        body: { members: [{ userId: input.user_id, name: "A", email: "a@x", role }] },
      });
    const tool = teamMembersSetRole as unknown as typeof teamMembersSetRole & {
      before: (i: typeof input, c: unknown) => Promise<string>;
      summary: (i: typeof input) => string;
    };
    expect(await tool.before(input, members("member"))).toBe("same");
    expect(await tool.before(input, members("contributor"))).toBe("changed");
    expect(await tool.before(input, () => Promise.resolve({ status: 403, body: {} }))).toBe(
      "changed",
    );
    expect(tool.summary(input)).toContain("Member → Team admin");
  });
});
