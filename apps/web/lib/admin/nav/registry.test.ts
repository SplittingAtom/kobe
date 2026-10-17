import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONSOLE_SEGMENTS,
  CONSOLE_TITLES,
  SITE_SECTIONS,
  TEAM_SECTIONS,
  canOpenConsole,
  consoleHref,
  canSee,
  groupSections,
  sectionForPath,
  sectionHref,
  sectionProblems,
  sectionsOf,
  visibleSections,
} from "./registry";
import {
  defineSiteSection,
  READY,
  type ConsoleAccess,
  type ConsoleSection,
  type SiteAccess,
  OPEN_PLACEHOLDER_TICKETS,
  type TeamAccess,
} from "./types";
import { must } from "../../testing/must";

const REPO = new URL("../../../../../", import.meta.url);
const LEDGER_DIR = new URL("docs/ledger/", REPO);
const RUN_LEDGER = new URL("docs/RUN-LEDGER.md", REPO);

/**
 * Whether the run ledger records `ticket` as finished: named (exactly, so KOBE-6 is not KOBE-63)
 * in its "## Done" section, or on any line that says done or merged. Line-level on purpose: an
 * open ticket that shares a line with "done" fails loudly (move it to its own line) rather than
 * a done one passing quietly.
 */
function doneInRunLedger(ticket: string, text: string): boolean {
  const id = new RegExp(`${ticket}(?!\\d)`);
  let inDone = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) inDone = line.trim() === "## Done";
    if (id.test(line) && (inDone || /\b(done|merged)\b/i.test(line))) return true;
  }
  return false;
}

const user = { id: "u-1", name: "Ada", email: "ada@example.com" };
const site = (siteRole: SiteAccess["siteRole"]): SiteAccess => ({
  console: "site",
  user,
  siteRole,
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
  "team.memory.manage",
  "team.policy.manage",
  "team.egress.manage",
  "team.skills.review",
  "team.retention.manage",
  "team.eval.manage",
  "team.audit.read",
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
    expect(sectionProblems("site", SITE_SECTIONS)).toEqual([]);
    expect(sectionProblems("team", TEAM_SECTIONS)).toEqual([]);
  });

  // Derived from the filesystem, so a ticket that builds a section edits no shared test list.
  it.each(["site", "team"] as const)(
    "%s: a READY section has its page; a placeholder has none and names its ticket",
    (kind) => {
      for (const s of sectionsOf(kind)) {
        const page = existsSync(
          new URL(`../../../app/admin/${CONSOLE_SEGMENTS[kind]}/${s.id}/page.tsx`, import.meta.url),
        );
        if (s.status.kind === "ready") {
          expect(
            page,
            `${s.id} is READY: add app/admin/${CONSOLE_SEGMENTS[kind]}/${s.id}/page.tsx`,
          ).toBe(true);
        } else {
          expect(page, `${s.id} has a page: mark it READY`).toBe(false);
          expect(s.status.ticket).toMatch(/^KOBE-\d+$/);
        }
      }
    },
  );

  it.each(["site", "team"] as const)(
    "%s: a placeholder names only a ticket on the open list (KOBE-291)",
    (kind) => {
      for (const s of sectionsOf(kind)) {
        if (s.status.kind !== "placeholder") continue;
        expect(
          Object.keys(OPEN_PLACEHOLDER_TICKETS),
          `${s.id} waits for ${s.status.ticket}: add it to OPEN_PLACEHOLDER_TICKETS (types.ts) with why it is open`,
        ).toContain(s.status.ticket);
      }
    },
  );

  it.each(Object.entries(OPEN_PLACEHOLDER_TICKETS))(
    "%s on the open list is still open and still named (KOBE-291)",
    (ticket, reason) => {
      expect(reason.trim()).not.toBe("");
      expect(
        existsSync(new URL(`${ticket}.md`, LEDGER_DIR)),
        `${ticket} has a ledger (work on it started or finished): build its section, mark it READY and drop it from OPEN_PLACEHOLDER_TICKETS`,
      ).toBe(false);
      expect(
        doneInRunLedger(ticket, readFileSync(RUN_LEDGER, "utf8")),
        `${ticket} is done or merged in docs/RUN-LEDGER.md: build its section and drop it from OPEN_PLACEHOLDER_TICKETS`,
      ).toBe(false);
      const named = [...SITE_SECTIONS, ...TEAM_SECTIONS].some(
        (s) => s.status.kind === "placeholder" && s.status.ticket === ticket,
      );
      expect(named, `${ticket}: no placeholder names it; drop its line`).toBe(true);
    },
  );

  it("reads the run ledger's done tickets (the check above can fail)", () => {
    const real = readFileSync(RUN_LEDGER, "utf8");
    // KOBE-6 is in the run ledger's Done section; KOBE-63 must not match it.
    expect(doneInRunLedger("KOBE-6", real)).toBe(true);
    const text = [
      "## Current",
      "- KOBE-70 open",
      "- KOBE-71 merged (#9)",
      "## Done",
      "- KOBE-72: shipped",
      "## Later",
      "- KOBE-73 planned",
    ].join("\n");
    expect(doneInRunLedger("KOBE-70", text)).toBe(false);
    expect(doneInRunLedger("KOBE-71", text)).toBe(true);
    expect(doneInRunLedger("KOBE-72", text)).toBe(true);
    expect(doneInRunLedger("KOBE-73", text)).toBe(false);
    expect(doneInRunLedger("KOBE-7", text)).toBe(false);
  });

  it("keeps web search a placeholder on hold, with why", () => {
    const status = must(SITE_SECTIONS.find((s) => s.id === "web-search")).status;
    expect(status.kind).toBe("placeholder");
    expect(status.kind === "placeholder" && status.onHold).toMatch(/on hold/i);
  });

  it.each(["site", "team"] as const)("%s: every page directory belongs to a section", (kind) => {
    const dir = new URL(`../../../app/admin/${CONSOLE_SEGMENTS[kind]}/`, import.meta.url);
    const pages = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("["))
      .map((d) => d.name);
    const ids = sectionsOf(kind).map((s) => s.id);
    for (const page of pages)
      expect(ids, `app/admin/${CONSOLE_SEGMENTS[kind]}/${page} has no nav entry`).toContain(page);
  });

  it.each(["site", "team"] as const)(
    "%s: every section file is exported from the folder's index.ts",
    async (kind) => {
      const dir = new URL(`./${kind}/`, import.meta.url);
      const files = readdirSync(dir).filter(
        (f) => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".test.ts"),
      );
      const barrel = readFileSync(new URL("index.ts", dir), "utf8");
      for (const f of files) {
        expect(barrel, `${kind}/index.ts must export ./${f.replace(/\.ts$/, "")}`).toContain(
          `from "./${f.replace(/\.ts$/, "")}";`,
        );
      }
      // …and each file's section is the one registered (no copy-paste ids).
      const registered = new Set(sectionsOf(kind));
      for (const f of files) {
        const mod = (await import(`./${kind}/${f.replace(/\.ts$/, "")}.ts`)) as {
          default: ConsoleSection;
        };
        expect(registered.has(mod.default), `${kind}/${f}`).toBe(true);
        expect(mod.default.id, `${kind}/${f}: file name and id differ`).toBe(
          f.replace(/\.ts$/, ""),
        );
      }
    },
  );

  it("covers every site and team area of spec §6.1", () => {
    const site = SITE_SECTIONS.map((s) => s.id);
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
      expect(site).toContain(id);
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
    expect(SITE_SECTIONS.slice(0, 3).map((s) => s.id)).toEqual(["users", "invites", "roles"]);
    expect(TEAM_SECTIONS.slice(0, 3).map((s) => s.id)).toEqual(["members", "invites", "agents"]);
  });
});

describe("sectionProblems", () => {
  it("catches duplicates, bad segments and entries filed under the wrong console", () => {
    const ok = defineSiteSection({
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
  it("opens the site console to the Owner and Admins only", () => {
    expect(canOpenConsole(site("owner"))).toBe(true);
    expect(canOpenConsole(site("admin"))).toBe(true);
    expect(canOpenConsole(site("user"))).toBe(false);
    expect(visibleSections(site("user"))).toEqual([]);
  });

  it("opens the team console to team admins and, for the agent builder, to builders", () => {
    expect(canOpenConsole(team("team_admin", TEAM_ADMIN))).toBe(true);
    expect(visibleSections(team("team_admin", TEAM_ADMIN))).toHaveLength(TEAM_SECTIONS.length);
    // Builders get the agent builder (team.agents.build), the skill editor and nothing that needs admin rights.
    expect(canOpenConsole(team("builder", BUILDER))).toBe(true);
    expect(visibleSections(team("builder", BUILDER)).map((s) => s.id)).toEqual([
      "agents",
      "skills",
    ]);
    expect(canOpenConsole(team("member", MEMBER))).toBe(false);
  });

  it("never lets one console's access open the other's sections", () => {
    const admin: ConsoleAccess = site("owner");
    for (const s of TEAM_SECTIONS) expect(canSee(s, admin)).toBe(false);
    const teamAdmin = team("team_admin", TEAM_ADMIN);
    for (const s of SITE_SECTIONS) expect(canSee(s, teamAdmin)).toBe(false);
  });

  it("honours owner-only sections", () => {
    const ownerOnly = defineSiteSection({
      id: "x",
      label: "X",
      description: "d",
      group: "System",
      order: 1,
      minRole: "owner",
      status: READY,
    });
    expect(canSee(ownerOnly, site("owner"))).toBe(true);
    expect(canSee(ownerOnly, site("admin"))).toBe(false);
  });

  it("shows a team section only with its permission", () => {
    const members = must(TEAM_SECTIONS.find((s) => s.id === "members"));
    expect(canSee(members, team("member", MEMBER))).toBe(false);
    expect(canSee(members, team("team_admin", ["team.members.manage"]))).toBe(true);
  });
});

describe("paths and groups", () => {
  it("maps sections to /admin/<console>/<id> and back", () => {
    const users = must(SITE_SECTIONS.find((s) => s.id === "users"));
    // KOBE-257: the Site console is served under /admin/site.
    expect(sectionHref(users)).toBe("/admin/site/users");
    expect(consoleHref("site")).toBe("/admin/site");
    expect(CONSOLE_TITLES.site).toBe("Site console");
    expect(sectionForPath("site", "/admin/site/users")).toBe(users);
    expect(sectionForPath("site", "/admin/site/users/abc")).toBe(users);
    expect(sectionForPath("site", "/admin/site")).toBeNull();
    expect(sectionForPath("site", "/admin/site/nope")).toBeNull();
    expect(sectionForPath("site", "/admin/install/users")).toBeNull();
    expect(sectionForPath("team", "/admin/site/users")).toBeNull();
  });

  it("groups consecutive sections and keeps group order", () => {
    const groups = groupSections(SITE_SECTIONS);
    expect(groups.map((g) => g.group)).toEqual([
      "People",
      "Teams and agents",
      "Models and connectors",
      "Safety",
      "Governance",
      "System",
    ]);
    expect(groups.flatMap((g) => g.sections)).toEqual(SITE_SECTIONS);
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
      // The agent builder and skill editor are the sections builders open (KOBE-84, KOBE-83); the rest are admin-only.
      const level = s.id === "agents" || s.id === "skills" ? "builder" : "team_admin";
      expect(defined.get(s.permission), `${s.id} → ${s.permission}`).toBe(level);
    }
  });
});
