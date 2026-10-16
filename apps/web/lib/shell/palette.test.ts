import { describe, expect, it, vi } from "vitest";
import { COMMANDS } from "./commands";
import type { MenuBindings } from "./menu";
import {
  filterActions,
  filterChoices,
  matchesQuery,
  navigationBindings,
  paletteActions,
  paletteOutcome,
} from "./palette";
import { NOT_HERE, NOT_YOURS, READ_ONLY_HERE } from "./slash";

/** KOBE-225 (CE23): the palette's pure half: what it lists, and what a pick does. */
describe("paletteActions", () => {
  it("lists every action with a / word, a shortcut, a link or the palette mark, not itself", () => {
    const ids = paletteActions({}, { readOnly: false }).map((a) => a.command.id);
    const expected = COMMANDS.filter(
      (c) =>
        c.id !== "command-palette" &&
        (c.slash !== undefined || c.shortcut !== undefined || c.href !== undefined || c.palette),
    ).map((c) => c.id);
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(ids).toContain("theme");
    expect(ids).toContain("team-console");
    expect(ids).not.toContain("command-palette");
    // Navigation last, as in the / menu.
    const firstLink = ids.findIndex((id) => COMMANDS.find((c) => c.id === id)?.href);
    expect(ids.slice(firstLink).every((id) => COMMANDS.find((c) => c.id === id)?.href)).toBe(true);
  });

  it("uses the / menu's rules: unbound, not yours, read-only, or the binding's own reason", () => {
    const bindings: MenuBindings = {
      stop: { onSelect: vi.fn(), blocker: "Nothing is running." },
      "new-thread": { onSelect: vi.fn() },
      "pin-thread": { onSelect: vi.fn() },
    };
    const by = (readOnly: boolean) =>
      new Map(paletteActions(bindings, { readOnly }).map((a) => [a.command.id, a.blocker]));
    expect(by(false).get("stop")).toBe("Nothing is running.");
    expect(by(false).get("new-thread")).toBeNull();
    expect(by(false).get("detail")).toBe(NOT_HERE);
    expect(by(false).get("team-console")).toBe(NOT_YOURS);
    expect(by(true).get("pin-thread")).toBe(READ_ONLY_HERE);
    expect(by(true).get("new-thread")).toBeNull();
  });

  it("takes the binding's label (a toggle's current state)", () => {
    const [rail] = paletteActions(
      { "toggle-rail": { label: "Expand the rail", onSelect: vi.fn() } },
      { readOnly: false },
    ).filter((a) => a.command.id === "toggle-rail");
    expect(rail?.label).toBe("Expand the rail");
  });
});

describe("filtering", () => {
  it("matches every word, in any order, case-insensitively", () => {
    expect(matchesQuery("Move to project", "proj MOVE")).toBe(true);
    expect(matchesQuery("Move to project", "move pin")).toBe(false);
    expect(matchesQuery("anything", "  ")).toBe(true);
  });

  it("finds actions by label, name or / word", () => {
    const actions = paletteActions(
      { "toggle-rail": { label: "Expand the rail", onSelect: vi.fn() } },
      { readOnly: false },
    );
    const ids = (q: string) => filterActions(actions, q).map((a) => a.command.id);
    expect(ids("expand")).toEqual(["toggle-rail"]);
    expect(ids("collapse")).toEqual(["toggle-rail"]);
    expect(ids("regenerate-with")).toEqual(["regenerate-thread-with"]);
  });

  it("finds choices by label or key", () => {
    const choices = [
      { key: "glm", label: "GLM 5.3", onSelect: vi.fn() },
      { key: "kimi", label: "Kimi K2.7 Code", onSelect: vi.fn() },
    ];
    expect(filterChoices(choices, "k2").map((c) => c.key)).toEqual(["kimi"]);
    expect(filterChoices(choices, "glm").map((c) => c.key)).toEqual(["glm"]);
  });
});

describe("paletteOutcome", () => {
  const actionOf = (bindings: MenuBindings, id: string) => {
    const found = paletteActions(bindings, { readOnly: false }).find((a) => a.command.id === id);
    if (!found) throw new Error(id);
    return found;
  };

  it("runs a bound action's handler", () => {
    const onSelect = vi.fn();
    const out = paletteOutcome(actionOf({ "new-thread": { onSelect } }, "new-thread"));
    expect(out.kind).toBe("run");
    if (out.kind === "run") out.run();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("refuses a blocked one with its reason and runs nothing", () => {
    const onSelect = vi.fn();
    const out = paletteOutcome(
      actionOf({ stop: { onSelect, blocker: "Nothing is running." } }, "stop"),
    );
    expect(out).toEqual({ kind: "blocked", reason: "Stop: Nothing is running." });
    expect(paletteOutcome(actionOf({}, "detail"))).toEqual({
      kind: "blocked",
      reason: `Show all details: ${NOT_HERE}`,
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("lists an action's choices next, unless it has none", () => {
    const choice = { key: "glm", label: "GLM", onSelect: vi.fn() };
    const withChoices = actionOf(
      { "regenerate-thread-with": { choices: [choice] } },
      "regenerate-thread-with",
    );
    expect(paletteOutcome(withChoices).kind).toBe("choose");
    const empty = actionOf({ "move-thread": { choices: [] } }, "move-thread");
    expect(paletteOutcome(empty)).toEqual({
      kind: "blocked",
      reason: "Move to project: Nothing to choose from right now.",
    });
  });

  it("navigation commands go where their link goes, consoles included", () => {
    const go = vi.fn();
    const nav = navigationBindings(go);
    nav["my-memory"]?.onSelect?.();
    nav["team-console"]?.onSelect?.();
    expect(go.mock.calls.map(([href]) => href)).toEqual([
      "/me/memory",
      expect.stringContaining("team"),
    ]);
  });
});
