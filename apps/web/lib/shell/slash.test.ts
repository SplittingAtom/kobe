import { describe, expect, it, vi } from "vitest";
import { COMMANDS } from "./commands";
import type { MenuBindings } from "./menu";
import {
  SLASH_TRIGGER,
  hrefBindings,
  slashEntries,
  slashItems,
  slashMatcher,
  slashOutcome,
  slashQueryAt,
} from "./slash";

/** KOBE-224 (CE22): the `/` menu's pure half: where it opens, what it lists, what a pick does. */
describe("slashQueryAt: the menu opens only at the start of the composer", () => {
  it("opens for / in an empty composer or after leading whitespace", () => {
    expect(slashQueryAt("/", 1)).toEqual({ offset: 0, name: "", arg: undefined });
    expect(slashQueryAt("/com", 4)).toEqual({ offset: 0, name: "com", arg: undefined });
    expect(slashQueryAt("  \n/com", 7)).toEqual({ offset: 3, name: "com", arg: undefined });
  });

  it("reads an argument after one space", () => {
    expect(slashQueryAt("/move ", 6)).toEqual({ offset: 0, name: "move", arg: "" });
    expect(slashQueryAt("/move Budget 20", 15)).toEqual({
      offset: 0,
      name: "move",
      arg: "Budget 20",
    });
  });

  it("stays closed for a / in the middle of text, a second line, or text after the caret", () => {
    expect(slashQueryAt("see /com", 8)).toBeNull();
    expect(slashQueryAt("a/b", 3)).toBeNull();
    expect(slashQueryAt("/compact\nmore", 13)).toBeNull();
    expect(slashQueryAt("/comhello", 4)).toBeNull();
    expect(slashQueryAt("/com", 0)).toBeNull();
  });

  it("the trigger matcher spans the whole command, so a pick removes all of it", () => {
    expect(slashMatcher(" /com", SLASH_TRIGGER, 5)).toEqual({
      query: "com",
      offset: 1,
      endOffset: 5,
    });
    expect(slashMatcher("x /com", SLASH_TRIGGER, 6)).toBeNull();
    expect(slashMatcher("/com", "@", 4)).toBeNull();
  });
});

const run = vi.fn();
const bindings: MenuBindings = {
  "compact-thread": { onSelect: run },
  stop: { onSelect: run, blocker: "No run to stop." },
  "copy-thread": { onSelect: run },
  "move-thread": {
    choices: [
      { key: "", label: "No project", current: true, onSelect: run },
      { key: "p1", label: "Budget 2026", onSelect: run },
    ],
  },
  "regenerate-thread-with": { choices: [], blocker: "Wait for the current run to finish." },
  // Bound but without a `/` word: never listed.
  "trash-thread": { onSelect: run },
};

describe("slashEntries: registered, bound actions in registry order", () => {
  it("lists only commands with a / word and a binding", () => {
    const ids = slashEntries(bindings, { readOnly: false }).map((e) => e.command.id);
    expect(ids).toEqual([
      "compact-thread",
      "copy-thread",
      "regenerate-thread-with",
      "move-thread",
      "stop",
    ]);
  });

  it("a reader of a shared thread sees only the read-only-safe ones", () => {
    const ids = slashEntries(bindings, { readOnly: true }).map((e) => e.command.id);
    expect(ids).toEqual(["copy-thread"]);
  });

  it("every / word is unique and a single lowercase word", () => {
    const words = COMMANDS.flatMap((c) => (c.slash === undefined ? [] : [c.slash]));
    expect(new Set(words).size).toBe(words.length);
    for (const w of words) expect(w).toMatch(/^[a-z][a-z-]*$/);
  });
});

describe("slashItems", () => {
  const entries = slashEntries(bindings, { readOnly: false });

  it("lists the actions whose word starts with the query, with their argument and state", () => {
    const items = slashItems({ offset: 0, name: "", arg: undefined }, entries);
    expect(items.map((i) => i.label)).toEqual([
      "/compact",
      "/copy",
      "/regenerate-with",
      "/move",
      "/stop",
    ]);
    const move = items.find((i) => i.label === "/move");
    expect(move?.metadata).toMatchObject({ arg: "project", blocker: null });
    const stop = items.find((i) => i.label === "/stop");
    expect(stop?.metadata).toMatchObject({ blocker: "No run to stop." });
    expect(
      slashItems({ offset: 0, name: "CO", arg: undefined }, entries).map((i) => i.label),
    ).toEqual(["/compact", "/copy"]);
  });

  it("an unknown word lists nothing, so Enter sends the text", () => {
    expect(slashItems({ offset: 0, name: "hello", arg: undefined }, entries)).toEqual([]);
    expect(slashItems({ offset: 0, name: "hello", arg: "" }, entries)).toEqual([]);
  });

  it("after the word and a space, lists the argument's choices matching what follows", () => {
    const all = slashItems({ offset: 0, name: "move", arg: "" }, entries);
    expect(all.map((i) => [i.label, i.description])).toEqual([
      ["No project", "current"],
      ["Budget 2026", undefined],
    ]);
    const some = slashItems({ offset: 0, name: "move", arg: "bud" }, entries);
    expect(some.map((i) => i.label)).toEqual(["Budget 2026"]);
    expect(slashItems({ offset: 0, name: "move", arg: "zzz" }, entries)).toEqual([]);
  });

  it("an action without an argument still matches with a trailing space, not with words", () => {
    expect(
      slashItems({ offset: 0, name: "compact", arg: "" }, entries).map((i) => i.label),
    ).toEqual(["/compact"]);
    expect(slashItems({ offset: 0, name: "compact", arg: "now" }, entries)).toEqual([]);
  });
});

describe("slashOutcome", () => {
  const entries = slashEntries(bindings, { readOnly: false });
  const pick = (name: string, arg?: string) =>
    slashItems({ offset: 0, name, arg }, entries)[0] ?? { id: "x", type: "command", label: "" };

  it("runs the binding's own handler", () => {
    const out = slashOutcome(pick("compact"), entries);
    expect(out).toEqual({ kind: "run", run });
  });

  it("completes an action that takes an argument (Tab or Enter), then runs the choice", () => {
    expect(slashOutcome(pick("move"), entries)).toEqual({ kind: "complete", text: "/move " });
    expect(slashOutcome(pick("move", "bud"), entries)).toEqual({
      kind: "run",
      run: bindings["move-thread"]?.choices?.[1]?.onSelect,
    });
  });

  it("refuses an action that can't run now, with the reason", () => {
    expect(slashOutcome(pick("stop"), entries)).toEqual({
      kind: "blocked",
      reason: "Stop: No run to stop.",
    });
    expect(slashOutcome(pick("regenerate-with"), entries)).toMatchObject({ kind: "blocked" });
  });

  it("an item of no listed action does nothing", () => {
    expect(slashOutcome({ id: "gone", type: "command", label: "/gone" }, entries)).toEqual({
      kind: "none",
    });
  });
});

describe("hrefBindings", () => {
  it("binds the navigation commands that have a / word to the given navigate", () => {
    const go = vi.fn();
    const bound = hrefBindings(go);
    bound["my-memory"]?.onSelect?.();
    expect(go).toHaveBeenCalledWith("/me/memory");
    expect(bound["team-console"]).toBeUndefined();
  });
});
