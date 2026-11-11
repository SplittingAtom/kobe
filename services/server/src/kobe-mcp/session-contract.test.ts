import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KOBE_ADMIN_TOOLS } from "./tools/index.js";

/**
 * A delegated request carries a synthetic session id (`kobe-delegation:<run>`) that matches no
 * session row (KOBE-619 review L2). No catalog route may depend on the session: its route module
 * (every module `app.ts` mounts on a prefix of the tool's path) and the modules it imports directly
 * must not read `sessionId`, the session's active team, or the session tables. KA-4/KA-5 tools add
 * a sample input here; a tool without one fails.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ID = "00000000-0000-4000-8000-000000000001";
const SAMPLES: Readonly<Record<string, unknown>> = {
  team_members_list: {},
  team_members_set_role: { user_id: ID, from_role: "member", to_role: "contributor" },
};
/** Reads the session, by design and for sessions only: requireTeam takes the delegation first. */
const EXEMPT = new Set(["authz/middleware.ts", "auth/session.ts"]);
const SESSION_KEYED =
  /get\(\s*"sessionId"\s*\)|var\.sessionId|readActiveTeamId|sessionActiveTeams|\bsessions\b\s*[,)]/;

const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

function mounts(): { prefix: string; file: string }[] {
  const app = read("app.ts");
  const imports = new Map<string, string>();
  for (const m of app.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/([^"]+)\.js"/g)) {
    for (const name of (m[1] ?? "").split(",")) {
      const clean = name.replace(/\btype\b/, "").trim();
      if (clean) imports.set(clean, `${m[2]}.ts`);
    }
  }
  return [...app.matchAll(/api\.route\(\s*"([^"]+)",\s*(\w+)\(/g)].flatMap((m) => {
    const file = imports.get(m[2] ?? "");
    return file === undefined ? [] : [{ prefix: m[1] ?? "", file }];
  });
}

/** A module mounted at `/` declares full paths: it serves `path` when one of them leads to it. */
function rootServes(file: string, path: string): boolean {
  return [...read(file).matchAll(/\.(?:get|post|put|patch|delete|all|on)\(\s*"([^"]+)"/g)].some(
    (m) => {
      const fixed = (m[1] ?? "").split("/:")[0] ?? "";
      return fixed !== "" && fixed !== "/" && path.startsWith(fixed);
    },
  );
}

function withDirectImports(file: string): string[] {
  const source = read(file);
  const here = dirname(file);
  const local = [...source.matchAll(/from\s*"(\.{1,2}\/[^"]+)\.js"/g)].map((m) =>
    join(here, `${m[1]}.ts`),
  );
  return [file, ...local];
}

describe("catalog routes never depend on the session (KOBE-619)", () => {
  it("names a sample for every tool", () => {
    expect(KOBE_ADMIN_TOOLS.map((t) => t.name).filter((n) => !(n in SAMPLES))).toEqual([]);
  });

  it.each(KOBE_ADMIN_TOOLS.map((t) => [t.name, t] as const))("%s", (_name, tool) => {
    const { path } = tool.route(tool.input.parse(SAMPLES[tool.name]));
    const modules = mounts().filter((m) =>
      m.prefix === "/"
        ? rootServes(m.file, path)
        : path === m.prefix || path.startsWith(`${m.prefix}/`),
    );
    expect(modules.length).toBeGreaterThan(0);
    const offenders = modules
      .flatMap((m) => withDirectImports(m.file))
      .filter((f) => !EXEMPT.has(f))
      .filter((f) => SESSION_KEYED.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("would catch a session-keyed route module", () => {
    expect(SESSION_KEYED.test(read("routes/my-teams.ts"))).toBe(true);
  });
});
