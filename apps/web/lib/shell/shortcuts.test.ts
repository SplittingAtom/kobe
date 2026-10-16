import { describe, expect, it } from "vitest";
import { command, COMMANDS, type CommandId } from "./commands";
import {
  CE23_SHORTCUTS,
  matchesShortcut,
  shortcutAllowed,
  shortcutCommand,
  shortcutOf,
  shortcutsOf,
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

  it("leaves Shift chords of punctuation to the browser (Cmd+Shift+[ is the previous tab)", () => {
    expect(shortcutCommand(cmd("[", { shiftKey: true }), true)).toBeNull();
    expect(shortcutCommand(cmd("{", { shiftKey: true, code: "BracketLeft" }), true)).toBeNull();
    expect(shortcutCommand(cmd("}", { shiftKey: true, code: "BracketRight" }), true)).toBeNull();
    expect(shortcutCommand(ctrl(">", { shiftKey: true, code: "Period" }), false)).toBeNull();
    // Cmd+Shift+/ types ? on a US layout: macOS's Help search, not ours.
    expect(shortcutCommand(cmd("?", { shiftKey: true, code: "Slash" }), true)).toBeNull();
  });

  it("takes the character a Latin layout typed, never a second physical key", () => {
    // Dvorak: physical B types x (cut stays cut); physical N types b (the rail, not New).
    expect(shortcutCommand(cmd("x", { code: "KeyB" }), true)).toBeNull();
    expect(shortcutCommand(cmd("b", { code: "KeyN" }), true)).toBe("toggle-rail");
    // Dvorak: physical . types e, which is not Stop.
    expect(shortcutCommand(cmd("e", { code: "Period" }), true)).toBeNull();
    // AZERTY: Ctrl+Shift+Q sits on physical A; only the A key is the artifact column.
    expect(shortcutCommand(ctrl("Q", { shiftKey: true, code: "KeyA" }), false)).toBeNull();
    expect(shortcutCommand(ctrl("A", { shiftKey: true, code: "KeyQ" }), false)).toBe(
      "toggle-artifacts",
    );
    // German: / is Shift+7, the character decides.
    expect(shortcutCommand(ctrl("/", { shiftKey: true, code: "Digit7" }), false)).toBe(
      "focus-composer",
    );
  });

  it("falls back to the physical key only when the layout typed no Latin character", () => {
    expect(shortcutCommand(ctrl("и", { code: "KeyB" }), false)).toBe("toggle-rail");
    expect(shortcutCommand(ctrl("ü", { code: "BracketLeft" }), false)).toBe("previous-thread");
    expect(shortcutCommand(ctrl("ü", { code: "BracketLeft", shiftKey: true }), false)).toBeNull();
  });

  it("New conversation also answers Mod+Shift+O, the key browsers pass to the page", () => {
    expect(shortcutCommand(ctrl("O", { shiftKey: true }), false)).toBe("new-thread");
    expect(shortcutCommand(cmd("o", { shiftKey: true }), true)).toBe("new-thread");
    expect(shortcutsOf(command("new-thread"))).toEqual(["Mod+Shift+O", "Mod+N"]);
  });

  it("no press is two commands' key: each key's own press finds its command", () => {
    const pressOf = (shortcut: string, mac: boolean): KeyPress => {
      const keys = shortcut.split("+");
      const key = keys.at(-1) ?? "";
      const mod = keys.includes("Mod");
      return press(key, {
        shiftKey: keys.includes("Shift"),
        metaKey: mod && mac,
        ctrlKey: mod && !mac,
      });
    };
    for (const c of COMMANDS) {
      for (const k of shortcutsOf(c)) {
        expect(shortcutCommand(pressOf(k, false), false)).toBe(c.id);
        expect(shortcutCommand(pressOf(k, true), true)).toBe(c.id);
      }
    }
  });

  it("opens the sheet with a plain ?, typed with or without Shift", () => {
    expect(shortcutCommand(press("?", { shiftKey: true }), false)).toBe("keyboard-shortcuts");
    expect(shortcutCommand(press("?"), true)).toBe("keyboard-shortcuts");
    expect(matchesShortcut("?", ctrl("?"), false)).toBe(false);
  });
});

const keyOf = (id: CommandId) => shortcutOf(id);

describe("shortcutAllowed: where a shortcut may run", () => {
  const free: PressPlace = {
    editing: false,
    composer: false,
    dialog: false,
    composing: false,
    frame: false,
  };

  it("runs everywhere outside text fields", () => {
    for (const id of CE23_SHORTCUTS) expect(shortcutAllowed(id, free, keyOf(id))).toBe(true);
    expect(shortcutAllowed("keyboard-shortcuts", free, "?")).toBe(true);
  });

  it("runs every chord from the message box; from other fields only the palette", () => {
    const field = { ...free, editing: true };
    const composer = { ...field, composer: true };
    expect(CE23_SHORTCUTS.filter((id) => shortcutAllowed(id, composer, keyOf(id)))).toEqual([
      ...CE23_SHORTCUTS,
    ]);
    expect(CE23_SHORTCUTS.filter((id) => shortcutAllowed(id, field, keyOf(id)))).toEqual([
      "command-palette",
    ]);
  });

  it("never runs a bare key (?) from a text field: it is typing", () => {
    const field = { ...free, editing: true };
    expect(shortcutAllowed("keyboard-shortcuts", field, "?")).toBe(false);
    expect(shortcutAllowed("keyboard-shortcuts", { ...field, composer: true }, "?")).toBe(false);
  });

  it("never runs during IME composition, over a dialog, or from an iframe", () => {
    for (const place of [
      { ...free, composing: true },
      { ...free, dialog: true },
      { ...free, frame: true },
      { ...free, editing: true, composer: true, composing: true },
    ]) {
      expect(CE23_SHORTCUTS.filter((id) => shortcutAllowed(id, place, keyOf(id)))).toEqual([]);
    }
  });
});
