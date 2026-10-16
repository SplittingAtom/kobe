import { describe, expect, it } from "vitest";
import { command } from "./commands";
import {
  CE23_SHORTCUTS,
  matchesShortcut,
  shortcutAllowed,
  shortcutCommand,
  type KeyPress,
  type PressPlace,
} from "./shortcuts";

/** KOBE-225 (CE23): which command a key press names, and where it may run. */
const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  code: undefined,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const ctrl = (key: string, mods: Partial<KeyPress> = {}) => press(key, { ctrlKey: true, ...mods });
const cmd = (key: string, mods: Partial<KeyPress> = {}) => press(key, { metaKey: true, ...mods });

describe("the twelve CE23 shortcuts", () => {
  it("are twelve registry commands, each with a Mod key, none twice", () => {
    expect(CE23_SHORTCUTS).toHaveLength(12);
    const keys = CE23_SHORTCUTS.map((id) => command(id).shortcut);
    expect(new Set(keys).size).toBe(12);
    for (const k of keys) expect(k).toMatch(/^Mod\+/);
  });

  it.each([
    ["command-palette", "k", {}],
    ["new-thread", "n", {}],
    ["toggle-rail", "b", {}],
    ["files", "F", { shiftKey: true }],
    ["toggle-artifacts", "A", { shiftKey: true }],
    ["detail", "D", { shiftKey: true }],
    ["stop", ".", {}],
    ["steer", "Enter", { shiftKey: true }],
    ["edit-last-message", "E", { shiftKey: true }],
    ["previous-thread", "[", {}],
    ["next-thread", "]", {}],
    ["focus-composer", "/", {}],
  ] as const)("%s: Ctrl elsewhere, Cmd on macOS", (id, key, mods) => {
    expect(shortcutCommand(ctrl(key, mods), false)).toBe(id);
    expect(shortcutCommand(cmd(key, mods), true)).toBe(id);
    // The other platform's modifier is not Mod.
    expect(shortcutCommand(cmd(key, mods), false)).toBeNull();
    expect(shortcutCommand(ctrl(key, mods), true)).toBeNull();
  });

  it("wants Shift exactly for letters and Enter, and never Alt", () => {
    expect(shortcutCommand(ctrl("f"), false)).toBeNull();
    expect(shortcutCommand(ctrl("N", { shiftKey: true }), false)).toBeNull();
    expect(shortcutCommand(ctrl("Enter"), false)).toBeNull();
    expect(shortcutCommand(ctrl("k", { altKey: true }), false)).toBeNull();
    expect(shortcutCommand(press("k"), false)).toBeNull();
  });

  it("finds a letter by its key on a non-Latin layout, and punctuation typed with Shift", () => {
    expect(shortcutCommand(ctrl("и", { code: "KeyB" }), false)).toBe("toggle-rail");
    expect(shortcutCommand(ctrl("/", { shiftKey: true }), false)).toBe("focus-composer");
    expect(shortcutCommand(ctrl("ö", { code: "BracketLeft" }), false)).toBe("previous-thread");
  });

  it("opens the sheet with a plain ?, typed with or without Shift", () => {
    expect(shortcutCommand(press("?", { shiftKey: true }), false)).toBe("keyboard-shortcuts");
    expect(shortcutCommand(press("?"), true)).toBe("keyboard-shortcuts");
    expect(matchesShortcut("?", ctrl("?"), false)).toBe(false);
  });
});

describe("shortcutAllowed: where a shortcut may run", () => {
  const free: PressPlace = {
    editing: false,
    composer: false,
    dialog: false,
    composing: false,
    frame: false,
  };

  it("runs everywhere outside text fields", () => {
    for (const id of CE23_SHORTCUTS) expect(shortcutAllowed(id, free)).toBe(true);
  });

  it("lets only the palette run from a text field; the composer also Stop and Steer", () => {
    const field = { ...free, editing: true };
    const composer = { ...field, composer: true };
    expect(CE23_SHORTCUTS.filter((id) => shortcutAllowed(id, field))).toEqual(["command-palette"]);
    expect(CE23_SHORTCUTS.filter((id) => shortcutAllowed(id, composer))).toEqual([
      "command-palette",
      "stop",
      "steer",
    ]);
    expect(shortcutAllowed("keyboard-shortcuts", field)).toBe(false);
  });

  it("never runs during IME composition, over a dialog, or from an iframe", () => {
    for (const place of [
      { ...free, composing: true },
      { ...free, dialog: true },
      { ...free, frame: true },
    ]) {
      expect(CE23_SHORTCUTS.filter((id) => shortcutAllowed(id, place))).toEqual([]);
    }
  });
});
