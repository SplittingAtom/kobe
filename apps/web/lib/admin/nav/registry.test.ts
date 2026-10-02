import { describe, expect, it } from "vitest";
import {
  INSTALL_SECTIONS,
  TEAM_SECTIONS,
  canOpenConsole,
  canSee,
  groupSections,
  sectionForPath,
  sectionHref,
  sectionProblems,
  visibleSections,
} from "./registry";
import {
  defineInstallSection,
  READY,
  type ConsoleAccess,
  type InstallAccess,
  type TeamAccess,
} from "./types";
import { must } from "../../testing/must";

const user = { id: "u-1", name: "Ada", email: "ada@example.com" };
const install = (installRole: InstallAccess["installRole"]): InstallAccess => ({
  console: "install",
  user,
  installRole,
});

// Mirrors the server's TEAM_PERMISSIONS (services/server/src/authz/permissions.ts).
const MEMBER = [
  "team.read",
  "team.members.read",
  "team.chat",
  "team.agents.use",
  "team.personal.create",
  "team.grants.connect",
  "team.schedules.personal",
];
const BUILDER = [
  ...MEMBER,
  "team.agents.build",
  "team.agents.publish",
  "team.skills.publish",
  "team.projects.create",
];
const TEAM_ADMIN = [
  ...BUILDER,
  "team.members.manage",
  "team.models.manage",
  "team.budgets.manage",
  "team.connectors.manage",
  "team.policy.manage",
  "team.egress.manage",
  "team.skills.review",
  "team.retention.manage",
  "team.schedules.pause",
  "team.agents.suspend",
  "team.agents.manage",
  "team.projects.manage",
];
const team = (role: TeamAccess["role"], permissions: string[]): TeamAccess => ({
  console: "team",
  user,
  team: { id: "t-1", slug: "fin", name: "Finance" },
  role,
  permissions,
});

describe("registry contents", () => {
  it("has valid, unique entries in both consoles", () => {
    expect(sectionProblems("install", INSTALL_SECTIONS)).toEqual([]);
    expect(sectionProblems("team", TEAM_SECTIONS)).toEqual([]);
  });

  it("wires the pages whose APIs exist and marks the rest with their ticket", () => {
    const ready = (list: readonly { id: string; status: { kind: string } }[]) =>
      list
        .filter((s) => s.status.kind === "ready")
        .map((s) => s.id)
        .sort();
    expect(ready(INSTALL_SECTIONS)).toEqual(
      ["gallery", "invites", "isolation", "roles", "settings", "teams", "users"].sort(),
    );
    expect(ready(TEAM_SECTIONS)).toEqual(["agents", "invites", "members"]);
    const placeholders = [...INSTALL_SECTIONS, ...TEAM_SECTIONS].filter(
      (s) => s.status.kind === "placeholder",
    );
    for (const s of placeholders) {
      expect(s.status).toMatchObject({ ticket: expect.stringMatching(/^KOBE-\d+$/) });
    }
  });

  it("covers every install and team area of spec §6.1", () => {
    const install = INSTALL_SECTIONS.map((s) => s.id);
    for (const id of [
      "users",
      "invites",
      "teams",
      "models",
      "policy-floor",
      "connectors",
      "gallery",
      "skill-blocklist",
      "egress",
      "break-glass",
      "legal-hold",
      "audit",
      "backup",
    ]) {
      expect(install).toContain(id);
    }
    const teamIds = TEAM_SECTIONS.map((s) => s.id);
    for (const id of [
      "members",
      "models",
      "budgets",
      "connectors",
      "egress",
      "policy",
      "skill-review",
      "retention",
      "inventory",
      "audit",
    ]) {
      expect(teamIds).toContain(id);
    }
  });

  it("orders by group then order, regardless of barrel line order", () => {
    expect(INSTALL_SECTIONS.slice(0, 3).map((s) => s.id)).toEqual(["users", "invites", "roles"]);
    expect(TEAM_SECTIONS.slice(0, 3).map((s) => s.id)).toEqual(["members", "invites", "agents"]);
  });
});

describe("sectionProblems", () => {
  it("catches duplicates, bad segments and entries filed under the wrong console", () => {
    const ok = defineInstallSection({
      id: "a",
      label: "A",
      description: "d",
      group: "People",
      order: 1,
      minRole: "admin",
      status: READY,
    });
    const problems = sectionProblems("team", [ok, { ...ok }, { ...ok, id: "Bad/Seg" }]);
    expect(problems).toEqual(
      expect.arrayContaining([
        "a: listed in the team console",
        "a: duplicate id",
        "Bad/Seg: id must be a lowercase URL segment",
      ]),
    );
  });
});

describe("role gating", () => {
  it("opens the install console to the Owner and Admins only", () => {
    expect(canOpenConsole(install("owner"))).toBe(true);
    expect(canOpenConsole(install("admin"))).toBe(true);
    expect(canOpenConsole(install("user"))).toBe(false);
    expect(visibleSections(install("user"))).toEqual([]);
  });

  it("opens the team console to team admins only", () => {
    expect(canOpenConsole(team("team_admin", TEAM_ADMIN))).toBe(true);
    expect(visibleSections(team("team_admin", TEAM_ADMIN))).toHaveLength(TEAM_SECTIONS.length);
    expect(canOpenConsole(team("builder", BUILDER))).toBe(false);
    expect(canOpenConsole(team("member", MEMBER))).toBe(false);
  });

  it("never lets one console's access open the other's sections", () => {
    const admin: ConsoleAccess = install("owner");
    for (const s of TEAM_SECTIONS) expect(canSee(s, admin)).toBe(false);
    const teamAdmin = team("team_admin", TEAM_ADMIN);
    for (const s of INSTALL_SECTIONS) expect(canSee(s, teamAdmin)).toBe(false);
  });

  it("honours owner-only sections", () => {
    const ownerOnly = defineInstallSection({
      id: "x",
      label: "X",
      description: "d",
      group: "System",
      order: 1,
      minRole: "owner",
      status: READY,
    });
    expect(canSee(ownerOnly, install("owner"))).toBe(true);
    expect(canSee(ownerOnly, install("admin"))).toBe(false);
  });

  it("shows a team section only with its permission", () => {
    const members = must(TEAM_SECTIONS.find((s) => s.id === "members"));
    expect(canSee(members, team("member", MEMBER))).toBe(false);
    expect(canSee(members, team("team_admin", ["team.members.manage"]))).toBe(true);
  });
});

describe("paths and groups", () => {
  it("maps sections to /admin/<console>/<id> and back", () => {
    const users = must(INSTALL_SECTIONS.find((s) => s.id === "users"));
    expect(sectionHref(users)).toBe("/admin/install/users");
    expect(sectionForPath("install", "/admin/install/users")).toBe(users);
    expect(sectionForPath("install", "/admin/install/users/abc")).toBe(users);
    expect(sectionForPath("install", "/admin/install")).toBeNull();
    expect(sectionForPath("install", "/admin/install/nope")).toBeNull();
    expect(sectionForPath("team", "/admin/install/users")).toBeNull();
  });

  it("groups consecutive sections and keeps group order", () => {
    const groups = groupSections(INSTALL_SECTIONS);
    expect(groups.map((g) => g.group)).toEqual([
      "People",
      "Teams and agents",
      "Models and connectors",
      "Safety",
      "Governance",
      "System",
    ]);
    expect(groups.flatMap((g) => g.sections)).toEqual(INSTALL_SECTIONS);
  });
});

describe("mirrors the server's permission matrix", () => {
  it("names only permissions the server defines, at the level the server requires", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("../../../../../services/server/src/authz/permissions.ts", import.meta.url),
      "utf8",
    );
    const defined = new Map(
      [...source.matchAll(/"(team\.[a-z_.]+)": "(member|builder|team_admin)"/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    for (const s of TEAM_SECTIONS) {
      expect(defined.get(s.permission), `${s.id} → ${s.permission}`).toBe("team_admin");
    }
  });
});
