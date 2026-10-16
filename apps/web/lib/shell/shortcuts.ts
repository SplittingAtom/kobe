/**
 * The CE23 keyboard shortcuts (KOBE-225), their pure half: which registry command a key press
 * names, and whether the press may run it where it happened. Fixed, not customizable: the keys
 * live on the commands (`lib/shell/commands.ts`, `Mod` is Cmd on macOS and Ctrl elsewhere); the
 * handler (`components/shell/shortcut-keys.tsx`) runs the command's live binding, the same one its
 * button, the `/` menu and the palette run.
 */
import { command, COMMANDS, type CommandId } from "./commands";

/** The twelve, in the spec's order: the `?` sheet lists exactly these. */
export const CE23_SHORTCUTS = [
  "command-palette",
  "new-thread",
  "toggle-rail",
  "files",
  "toggle-artifacts",
  "detail",
  "stop",
  "steer",
  "edit-last-message",
  "previous-thread",
  "next-thread",
  "focus-composer",
] as const satisfies readonly CommandId[];

/** The sheet's words where a command's name is one state of a toggle ("Collapse the rail"). */
export const SHEET_NAMES: Partial<Readonly<Record<CommandId, string>>> = {
  "toggle-rail": "Collapse or expand the rail",
  files: "Show the files",
  detail: "Show or hide all details",
  "command-palette": "Search actions, threads and files",
};

/** Keys of the message box the `?` sheet also names (not commands of their own). */
export const COMPOSER_KEYS: readonly { readonly keys: string; readonly name: string }[] = [
  { keys: "Enter", name: "Send (queue while the agent works)" },
  { keys: "Shift+Enter", name: "New line" },
  { keys: "↑", name: "Edit your last message, from an empty message box" },
  { keys: "/", name: "Actions, at the start of the message box" },
  { keys: "@", name: "Mention a workspace file" },
];

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** What a press carries that matters here (a DOM `KeyboardEvent` fits). */
export interface KeyPress {
  readonly key: string;
  readonly code?: string | undefined;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** The physical key of a punctuation shortcut: the fallback when a layout maps it elsewhere. */
const CODES: Readonly<Record<string, string>> = {
  ".": "Period",
  "[": "BracketLeft",
  "]": "BracketRight",
  "/": "Slash",
};

function keyMatches(want: string, press: KeyPress): boolean {
  if (want.length === 1 && /[a-z]/i.test(want)) {
    // A letter: the character, or the key in its place on a non-Latin layout.
    return press.key.toLowerCase() === want.toLowerCase() || press.code === `Key${want}`;
  }
  return press.key === want || (CODES[want] !== undefined && press.code === CODES[want]);
}

/**
 * Whether `press` is `shortcut` on this platform. `Mod` is Cmd on macOS (Ctrl must be up) and
 * Ctrl elsewhere (Meta must be up); Alt is never part of a CE23 key. A punctuation key ignores
 * Shift, which some layouts need to type it; a plain `?` is the character itself.
 */
export function matchesShortcut(shortcut: string, press: KeyPress, mac: boolean): boolean {
  if (press.altKey) return false;
  const keys = shortcut.split("+");
  const key = keys.at(-1) ?? "";
  const mod = keys.includes("Mod");
  const shift = keys.includes("Shift");
  const [wantMeta, wantCtrl] = mod ? (mac ? [true, false] : [false, true]) : [false, false];
  if (press.metaKey !== wantMeta || press.ctrlKey !== wantCtrl) return false;
  const punctuation = !/^[a-z]$/i.test(key) && key.length === 1;
  if (!punctuation && press.shiftKey !== shift) return false;
  if (punctuation && shift && !press.shiftKey) return false;
  return keyMatches(key, press);
}

const KEYED = COMMANDS.filter((c) => c.shortcut !== undefined);

/** The registry command whose shortcut `press` is, if any. */
export function shortcutCommand(press: KeyPress, mac: boolean): CommandId | null {
  return KEYED.find((c) => matchesShortcut(c.shortcut ?? "", press, mac))?.id ?? null;
}

/** Where the press happened, as far as the rules below care. */
export interface PressPlace {
  /** An input, textarea, select or editable element has the focus. */
  readonly editing: boolean;
  /** That field is the conversation's message box. */
  readonly composer: boolean;
  /** A modal dialog is open (the palette, a confirm, the rail drawer, the artifact sheet). */
  readonly dialog: boolean;
  /** An IME is composing text. */
  readonly composing: boolean;
  /** An iframe (an artifact's preview) has the focus. */
  readonly frame: boolean;
}

/** Keys that also work from the message box: what the composer documents beside Enter. */
const COMPOSER_SAFE: ReadonlySet<CommandId> = new Set(["command-palette", "stop", "steer"]);

/**
 * Whether `id` may run for a press at `place`. Never while an IME composes, from an iframe (an
 * artifact's preview: sandboxed and cross-origin, so its keys normally never reach the page) or
 * over a modal dialog. In a text field only the palette runs, and in the message box also Stop
 * and Steer; everything else is typing.
 */
export function shortcutAllowed(id: CommandId, place: PressPlace): boolean {
  if (place.composing || place.frame || place.dialog) return false;
  if (!place.editing) return true;
  if (id === "command-palette") return true;
  return place.composer && COMPOSER_SAFE.has(id);
}

/** The CE23 shortcut of `id` (all twelve have one). */
export function shortcutOf(id: CommandId): string {
  return command(id).shortcut ?? "";
}
