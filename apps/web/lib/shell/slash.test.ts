import { describe, expect, it, vi } from "vitest";
import { COMMANDS } from "./commands";
import type { MenuBindings } from "./menu";
import {
  NOT_HERE,
  READ_ONLY_HERE,
  SLASH_NO_MATCH,
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

const blockers = (readOnly: boolean) =>
  Object.fromEntries(
    slashEntries(bindings, { readOnly }).map((e) => [e.command.id, e.blocker] as const),
  );

describe("slashEntries: every registered / word, known whether bound or not", () => {
  it("lists every command with a / word, thread actions first and navigation last", () => {
    const entries = slashEntries(bindings, { readOnly: false });
    const words = COMMANDS.flatMap((c) => (c.slash === undefined ? [] : [c.slash]));
    expect(entries.map((e) => e.slash).sort()).toEqual([...words].sort());
    expect(entries.map((e) => e.slash).slice(-3)).toEqual(["memory", "schedules", "agents"]);
    expect(entries.map((e) => e.command.id)).not.toContain("trash-thread");
  });

  it("an unbound action is listed as not available here; a bound one carries its blocker", () => {
    const b = blockers(false);
    expect(b["compact-thread"]).toBeNull();
    expect(b["stop"]).toBe("No run to stop.");
    expect(b["pin-thread"]).toBe(NOT_HERE);
    expect(b["new-thread"]).toBe(NOT_HERE);
  });

  it("a reader of a shared thread gets the others blocked as read-only", () => {
    const b = blockers(true);
    expect(b["copy-thread"]).toBeNull();
    expect(b["compact-thread"]).toBe(READ_ONLY_HERE);
    expect(b["move-thread"]).toBe(READ_ONLY_HERE);
  });

  it("every / word is unique and a single lowercase word", () => {
    const words = COMMANDS.flatMap((c) => (c.slash === undefined ? [] : [c.slash]));
    expect(new Set(words).size).toBe(words.length);
    for (const w of words) expect(w).toMatch(/^[a-z][a-z-]*$/);
  });
});

describe("slashItems", () => {
  const entries = slashEntries(bindings, { readOnly: false });
  const labels = (name: string, arg?: string) =>
    slashItems({ offset: 0, name, arg }, entries).map((i) => i.label);

  it("lists the actions whose word starts with the query, with their argument and state", () => {
    const items = slashItems({ offset: 0, name: "", arg: undefined }, entries);
    expect(items[0]?.label).toBe("/files");
    const move = items.find((i) => i.label === "/move");
    expect(move?.metadata).toMatchObject({ arg: "project", blocker: null });
    const stop = items.find((i) => i.label === "/stop");
    expect(stop?.metadata).toMatchObject({ blocker: "No run to stop." });
    expect(labels("CO")).toEqual(["/compact", "/copy"]);
  });

  it("only a word no action has lists nothing, so Enter sends the text", () => {
    expect(labels("hello")).toEqual([]);
    expect(labels("hello", "")).toEqual([]);
  });

  it("after the word and a space, lists the argument's choices matching what follows", () => {
    const all = slashItems({ offset: 0, name: "move", arg: "" }, entries);
    expect(all.map((i) => [i.label, i.description])).toEqual([
      ["No project", "current"],
      ["Budget 2026", undefined],
    ]);
    expect(labels("move", "bud")).toEqual(["Budget 2026"]);
  });

  it("a known word whose argument matches nothing keeps one disabled row", () => {
    const [none] = slashItems({ offset: 0, name: "move", arg: "zzz" }, entries);
    expect(none).toMatchObject({ type: SLASH_NO_MATCH, label: "No project matches “zzz”." });
    expect(labels("compact", "now")).toEqual(["/compact takes no argument."]);
    expect(labels("compact", "")).toEqual(["/compact"]);
  });

  it("a blocked or unbound known word keeps its own row, whatever follows", () => {
    expect(labels("regenerate-with", "glm")).toEqual(["/regenerate-with"]);
    expect(labels("pin", "x")).toEqual(["/pin"]);
  });
});

describe("slashOutcome", () => {
  const entries = slashEntries(bindings, { readOnly: false });
  const pick = (name: string, arg?: string) =>
    slashItems({ offset: 0, name, arg }, entries)[0] ?? { id: "x", type: "command", label: "" };

  it("runs the binding's own handler", () => {
    expect(slashOutcome(pick("compact"), entries)).toEqual({ kind: "run", run });
  });

  it("completes an action that takes an argument (Tab or Enter), then runs the choice", () => {
    expect(slashOutcome(pick("move"), entries)).toEqual({ kind: "complete", text: "/move " });
    expect(slashOutcome(pick("move", "bud"), entries)).toEqual({
      kind: "run",
      run: bindings["move-thread"]?.choices?.[1]?.onSelect,
    });
  });

  it("refuses an action that can't run now, a no-match row and an unbound action", () => {
    expect(slashOutcome(pick("stop"), entries)).toEqual({
      kind: "blocked",
      reason: "Stop: No run to stop.",
    });
    expect(slashOutcome(pick("regenerate-with"), entries)).toMatchObject({ kind: "blocked" });
    expect(slashOutcome(pick("move", "zzz"), entries)).toEqual({
      kind: "blocked",
      reason: "No project matches “zzz”.",
    });
    expect(slashOutcome(pick("pin"), entries)).toEqual({
      kind: "blocked",
      reason: `Pin: ${NOT_HERE}`,
    });
    expect(slashOutcome({ id: "gone", type: "command", label: "/gone" }, entries)).toMatchObject({
      kind: "blocked",
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
