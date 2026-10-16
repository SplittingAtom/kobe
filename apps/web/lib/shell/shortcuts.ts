/**
 * The CE23 keyboard shortcuts (KOBE-225), their pure half: which registry command a key press
 * names, and whether the press may run it where it happened. Fixed, not customizable: the keys
 * live on the commands (`lib/shell/commands.ts`, `Mod` is Cmd on macOS and Ctrl elsewhere); the
 * handler (`components/shell/shortcut-keys.tsx`) runs the command's live binding, the same one its
 * button, the `/` menu and the palette run.
 */
import { command, COMMANDS, type CommandId, type RegisteredCommand } from "./commands";

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

/** What the sheet adds to a row. */
export const SHEET_NOTES: Partial<Readonly<Record<CommandId, string>>> = {
  "new-thread": "Mod+N works in an installed app only: browsers keep it for a new window.",
};

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

/** macOS (and iPadOS, which reports itself as a Mac): `Mod` is Cmd there. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    ?.platform;
  return /Mac|iPhone|iPad|iOS/i.test(hinted || navigator.platform || navigator.userAgent);
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

/** The physical key in the US place of a punctuation shortcut. */
const CODES: Readonly<Record<string, string>> = {
  ".": "Period",
  "[": "BracketLeft",
  "]": "BracketRight",
  "/": "Slash",
};

/** Characters some layouts type with Shift (German `/` is Shift+7): Shift is theirs to need. */
const SHIFT_FREE: ReadonlySet<string> = new Set(["/", "?"]);

/** A printable ASCII character: what the layout typed is the key (Dvorak, AZERTY, Colemak). */
const usable = (key: string) => /^[\x21-\x7e]$/u.test(key);

function physical(want: string): string | undefined {
  return /^[a-z]$/i.test(want) ? `Key${want.toUpperCase()}` : CODES[want];
}

/**
 * Whether the key is `want`: the character the layout typed when it is printable ASCII, so
 * Dvorak's and AZERTY's letters are theirs; only when it is not (a non-Latin layout, a dead key)
 * the physical key in `want`'s US place.
 */
function keyMatches(want: string, press: KeyPress): boolean {
  if (want.length > 1) return press.key === want;
  if (usable(press.key)) return press.key.toLowerCase() === want.toLowerCase();
  return physical(want) !== undefined && press.code === physical(want);
}

/**
 * Whether `press` is `shortcut` on this platform. `Mod` is Cmd on macOS (Ctrl must be up) and
 * Ctrl elsewhere (Meta must be up); Alt is never part of a CE23 key. Shift must match exactly
 * (Cmd+Shift+[ stays the browser's previous tab), except for `/` and `?`, which some layouts
 * type with Shift: there the character itself decides.
 */
export function matchesShortcut(shortcut: string, press: KeyPress, mac: boolean): boolean {
  if (press.altKey) return false;
  const keys = shortcut.split("+");
  const key = keys.at(-1) ?? "";
  const mod = keys.includes("Mod");
  const shift = keys.includes("Shift");
  const [wantMeta, wantCtrl] = mod ? (mac ? [true, false] : [false, true]) : [false, false];
  if (press.metaKey !== wantMeta || press.ctrlKey !== wantCtrl) return false;
  const shiftFree = SHIFT_FREE.has(key) && usable(press.key);
  if (!shiftFree && press.shiftKey !== shift) return false;
  return keyMatches(key, press);
}

/**
 * A command's keys as shown: the alias first where there is one (New conversation's Mod+Shift+O
 * works in every tab; Mod+N only in an installed app), then its CE23 shortcut.
 */
export function shortcutsOf(cmd: RegisteredCommand): readonly string[] {
  return [cmd.alias, cmd.shortcut].filter((k): k is string => k !== undefined);
}

const KEYED = COMMANDS.filter((c) => shortcutsOf(c).length > 0);

/** The registry command `press` names, and which of its keys it is. */
export function matchedShortcut(
  press: KeyPress,
  mac: boolean,
): { readonly id: CommandId; readonly shortcut: string } | null {
  for (const c of KEYED) {
    const shortcut = shortcutsOf(c).find((k) => matchesShortcut(k, press, mac));
    if (shortcut !== undefined) return { id: c.id, shortcut };
  }
  return null;
}

/** The registry command whose shortcut (or alias) `press` is, if any. */
export function shortcutCommand(press: KeyPress, mac: boolean): CommandId | null {
  return matchedShortcut(press, mac)?.id ?? null;
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

/**
 * Whether a press of `shortcut` for `id` may run at `place`. Never while an IME composes, from an
 * iframe (an artifact's preview: sandboxed and cross-origin, so its keys normally never reach the
 * page) or over a modal dialog. A bare key (`?`) never runs from a text field: it is typing. From
 * the message box, where the focus usually is, every Mod chord runs (none of them edits text);
 * from any other field (the search, an edit box) only the palette.
 */
export function shortcutAllowed(id: CommandId, place: PressPlace, shortcut: string): boolean {
  if (place.composing || place.frame || place.dialog) return false;
  if (!place.editing) return true;
  if (!shortcut.startsWith("Mod+")) return false;
  return place.composer || id === "command-palette";
}

/** The CE23 shortcut of `id` (all twelve have one). */
export function shortcutOf(id: CommandId): string {
  return command(id).shortcut ?? "";
}
