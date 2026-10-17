import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUDIT_CATEGORIES } from "./audit";

/**
 * The Category filter offers exactly the categories the server accepts (KOBE-291 review): the
 * first segment of every action in AUDIT_EVENTS. The web app can't import @kobe/db, so this reads
 * the source of truth and fails on drift.
 */
function serverCategories(): string[] {
  const source = readFileSync(
    new URL("../../../../../../packages/db/src/audit/events.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export const AUDIT_EVENTS = {");
  const end = source.indexOf("} as const;", start);
  expect(start, "AUDIT_EVENTS not found in events.ts").toBeGreaterThan(-1);
  const block = source.slice(start, end);
  const actions = [...block.matchAll(/^ {2}"([a-z_]+(?:\.[a-z_]+)+)":/gm)].map((m) => m[1] ?? "");
  // A parse that finds almost nothing would make the comparison meaningless.
  expect(actions.length).toBeGreaterThan(150);
  return [...new Set(actions.map((a) => a.split(".")[0] ?? a))].sort();
}

describe("audit categories", () => {
  it("match the server's AUDIT_EVENTS exactly", () => {
    expect([...AUDIT_CATEGORIES].sort()).toEqual(serverCategories());
  });

  it("have no duplicates", () => {
    expect(new Set(AUDIT_CATEGORIES).size).toBe(AUDIT_CATEGORIES.length);
  });
});
