import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard for the KOBE-16 decision (docs/ledger/KOBE-16.md, packages/db/README.md): every query on
 * `threads` and `thread_entries` states its team itself. Those tables carry a second, permissive
 * `break_glass_read` policy that Postgres ORs with the team policy, so a query that leaves the
 * team filter to RLS alone can lose the team-leading index. This scans the sources of
 * packages/db and services/server for drizzle queries (`.from(threads)`, `.update(threadEntries)`,
 * …) and raw SQL (`FROM threads`, `JOIN thread_entries`, `UPDATE threads`, `DELETE FROM …`) and
 * requires a team predicate in the same statement. `threads-plans.db.test.ts` proves the hot paths
 * with EXPLAIN; this catches new code early.
 *
 * A statement that really needs no team predicate carries `team-filter-ok: <reason>` in it.
 */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ROOTS = ["packages/db/src", "services/server/src"];

/** Any of these in the statement counts as its team predicate. */
const TEAM_MARKERS = [/team_?id/i, /readableBy\(/, /inScope\(/, /team-filter-ok:/];

const DRIZZLE = /\.(from|update|delete)\(\s*(threads|threadEntries)\s*\)/g;
const RAW = /\b(FROM|JOIN|UPDATE|DELETE\s+FROM)\s+"?(threads|thread_entries)"?\b/g;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!["testing", "test-support", "node_modules"].includes(name)) sources(path, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** The drizzle statement: from the match to the end of the chain (next `;`). */
function drizzleStatement(text: string, at: number): string {
  const end = text.indexOf(";", at);
  const start = text.lastIndexOf(";", at);
  return text.slice(start + 1, end === -1 ? undefined : end);
}

/** The raw SQL statement: the template literal (or quoted string) around the match. */
function rawStatement(text: string, at: number): string {
  const start = Math.max(text.lastIndexOf("`", at), text.lastIndexOf('"\n', at));
  const end = text.indexOf("`", at);
  return text.slice(start + 1, end === -1 ? undefined : end);
}

function isComment(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf("\n", at) + 1;
  return /^\s*(\*|\/\/|\/\*)/.test(text.slice(lineStart, at));
}

export function findUnfiltered(text: string): string[] {
  const problems: string[] = [];
  for (const [pattern, statementOf] of [
    [DRIZZLE, drizzleStatement],
    [RAW, rawStatement],
  ] as const) {
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0;
      if (isComment(text, at)) continue;
      const statement = statementOf(text, at);
      if (!TEAM_MARKERS.some((m) => m.test(statement))) {
        const line = text.slice(0, at).split("\n").length;
        problems.push(`line ${line}: ${match[0]}`);
      }
    }
  }
  return problems;
}

describe("explicit team filter on threads and thread_entries (KOBE-16)", () => {
  it("finds every query on those tables with a team predicate", () => {
    const problems = ROOTS.flatMap((root) =>
      sources(join(REPO, root)).flatMap((file) =>
        findUnfiltered(readFileSync(file, "utf8")).map((p) => `${relative(REPO, file)} ${p}`),
      ),
    );
    expect(problems).toEqual([]);
  });

  it("flags drizzle and raw SQL without one (self-test)", () => {
    expect(
      findUnfiltered("await tx.select().from(threads).where(eq(threads.id, id));"),
    ).toHaveLength(1);
    expect(
      findUnfiltered("sql`SELECT 1 FROM thread_entries WHERE thread_id = ${id}`;"),
    ).toHaveLength(1);
    expect(findUnfiltered("sql`UPDATE threads SET title = ${t} WHERE id = ${id}`;")).toHaveLength(
      1,
    );
    expect(
      findUnfiltered(
        "await tx.select().from(threads).where(and(eq(threads.teamId, t), eq(threads.id, id)));",
      ),
    ).toEqual([]);
    expect(
      findUnfiltered(
        "sql`SELECT 1 FROM runs r JOIN threads t ON t.team_id = r.team_id WHERE r.team_id = ${t}`;",
      ),
    ).toEqual([]);
    expect(findUnfiltered("// SELECT * FROM threads\n")).toEqual([]);
  });
});
