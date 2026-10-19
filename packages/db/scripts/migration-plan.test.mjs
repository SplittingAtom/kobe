import { describe, expect, it } from "vitest";
import {
  MAX_GENERATED_NAME,
  handWrittenBaseProblem,
  isHandWritten,
  rechainSnapshot,
  regenerationSteps,
} from "./migration-plan.mjs";

const schema = (tables) => ({ version: "7", dialect: "postgresql", tables, enums: {} });
const snap = (id, prevId, tables) => ({ id, prevId, ...schema(tables) });

describe("db:rebase plan for hand-written migrations (KOBE-256)", () => {
  it("recognises the first-line marker only", () => {
    expect(isHandWritten("-- kobe:hand-written\nALTER TABLE a RENAME TO b;")).toBe(true);
    expect(isHandWritten("ALTER TABLE a RENAME TO b;\n-- kobe:hand-written")).toBe(false);
    expect(isHandWritten("-- Custom SQL migration file")).toBe(false);
  });

  it("re-creates hand-written and custom migrations in order with their SQL; keeps the snapshot", () => {
    const kept = snap("old", "older", { site_settings: {} });
    const steps = regenerationSteps([
      {
        name: "site_rename",
        sql: "-- kobe:hand-written\n...",
        handWritten: true,
        custom: false,
        snapshot: kept,
      },
      { name: "site_rls", sql: "CREATE POLICY ...", handWritten: false, custom: true },
    ]);
    expect(steps).toEqual([
      {
        kind: "hand-written",
        name: "site_rename",
        sql: "-- kobe:hand-written\n...",
        snapshot: kept,
      },
      { kind: "custom", name: "site_rls", sql: "CREATE POLICY ..." },
    ]);
  });

  it("generates the generated ones first when there is no hand-written one", () => {
    const steps = regenerationSteps([
      { name: "a", sql: "CREATE TABLE a", handWritten: false, custom: false },
      { name: "a_rls", sql: "ALTER TABLE a ENABLE", handWritten: false, custom: true },
      { name: "b", sql: "CREATE TABLE b", handWritten: false, custom: false },
    ]);
    expect(steps.map((s) => [s.kind, s.name])).toEqual([
      ["generate", "a_b"],
      ["custom", "a_rls"],
    ]);
  });

  it("refuses hand-written together with generated migrations (drizzle-kit would diff the renames)", () => {
    expect(() =>
      regenerationSteps([
        { name: "site_rename", sql: "-- kobe:hand-written", handWritten: true, custom: false },
        { name: "b", sql: "CREATE TABLE b", handWritten: false, custom: false },
      ]),
    ).toThrow(/cannot be regenerated together/);
  });

  it("keeps a snapshot only when the base did not change the schema since the fork", () => {
    const hand = [{ name: "site_rename", handWritten: true, custom: false, sql: "" }];
    const fork = snap("f", "e", { old_settings: {} });
    expect(handWrittenBaseProblem(hand, fork, { ...fork, id: "g", prevId: "f" })).toBeNull();
    expect(handWrittenBaseProblem(hand, fork, snap("g", "f", { old_settings: {}, x: {} }))).toMatch(
      /renumber it by hand/,
    );
    expect(handWrittenBaseProblem([], fork, snap("g", "f", { x: {} }))).toBeNull();
  });

  it("re-chains a kept snapshot without touching its schema", () => {
    const kept = snap("old", "older", { site_settings: { columns: {} } });
    expect(rechainSnapshot(kept, { id: "new", prevId: "base-last" })).toEqual({
      ...kept,
      id: "new",
      prevId: "base-last",
    });
  });
});

describe("db:rebase names the regenerated migration", () => {
  it("joins a few names, and keeps a long list's name short enough for a file name", () => {
    const gen = (name) => ({ name, sql: "", handWritten: false, custom: false });
    expect(regenerationSteps([gen("a"), gen("b")])).toEqual([{ kind: "generate", name: "a_b" }]);
    const many = Array.from({ length: 20 }, (_, i) => gen(`a_rather_long_migration_name_${i}`));
    const [step] = regenerationSteps(many);
    expect(step.name.length).toBeLessThanOrEqual(MAX_GENERATED_NAME);
    expect(step.name).toBe("a_rather_long_migration_name_0_and_19_more");
  });
});
