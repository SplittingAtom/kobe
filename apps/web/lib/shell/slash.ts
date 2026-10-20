/**
 * The `/` actions menu (CE22, KOBE-224), its pure half. Typing `/` at the start of the composer
 * lists the registry's commands that have a `slash` word, each run through its live binding
 * (`MenuBinding`, published by the component that owns the action), so a pick runs the very
 * handler the button runs. Nothing is ever sent to Pi as a command: a pick removes the `/` text,
 * a known word that can't run stays in the composer with the reason, and only a word no action
 * has goes as an ordinary message.
 */
import type { TriggerItem, TriggerMatcher } from "@assistant-ui/react";
import { COMMANDS, isAvailable, type CommandContext, type RegisteredCommand } from "./commands";
import type { MenuBinding, MenuBindings } from "./menu";
import { notOfferedLabel, piCommand } from "./pi-commands";

export const SLASH_TRIGGER = "/";
/** `TriggerItem.type` of an action, and of one of its argument's choices. */
export const SLASH_COMMAND = "command";
export const SLASH_ARGUMENT = "argument";
/** A known word whose argument matches nothing: shown disabled, never sent. */
export const SLASH_NO_MATCH = "no-match";

/** What is typed: the `/` at `offset`, its word, and the argument after one space (if any). */
export interface SlashQuery {
  readonly offset: number;
  readonly name: string;
  readonly arg: string | undefined;
}

/** Leading whitespace, `/`, a word, then optionally one space and an argument on that line. */
const SHAPE = /^(\s*)\/(\S*)(?: ([^\n]*))?$/u;

/**
 * The `/` command being typed at `caret`, or null. Only when the `/` starts the composer (after
 * nothing but whitespace) and nothing but whitespace follows the caret: a `/` inside a message
 * never opens the menu.
 */
export function slashQueryAt(text: string, caret: number): SlashQuery | null {
  if (caret < 1 || text.slice(caret).trim() !== "") return null;
  const m = SHAPE.exec(text.slice(0, caret));
  if (!m) return null;
  return { offset: (m[1] ?? "").length, name: m[2] ?? "", arg: m[3] };
}

/**
 * assistant-ui's trigger detection for `/` (`TriggerPopover matcher`): the match spans to the end
 * of the text, so a pick removes the whole command (AC3).
 */
export const slashMatcher: TriggerMatcher = (text, char, caret) => {
  if (char !== SLASH_TRIGGER) return null;
  const q = slashQueryAt(text, caret);
  if (q === null) return null;
  return { query: text.slice(q.offset + 1, caret), offset: q.offset, endOffset: text.length };
};

/** Why a registered action can't run here when nothing binds it now (a draft, still loading). */
export const NOT_HERE = "Not available here right now.";
export const READ_ONLY_HERE = "This conversation is shared with you read-only.";
export const NOT_YOURS = "Not available to you.";

export interface SlashEntry {
  readonly command: RegisteredCommand;
  readonly slash: string;
  readonly label: string;
  readonly binding: MenuBinding;
  /** Why it can't run now; null when it can. */
  readonly blocker: string | null;
}

export interface SlashContext {
  /** The thread is shared with the viewer read-only (KOBE-221). */
  readonly readOnly: boolean;
  /** For commands with `available` (the consoles); absent: those are not available. */
  readonly consoles?: CommandContext["consoles"] | undefined;
}

const UNBOUND: MenuBinding = {};

/**
 * Why `command` can't run now, or null: one rule for the `/` menu, the palette and the shortcuts
 * (KOBE-225). A reader may run only the read-only-safe; an unbound command is not here now.
 */
export function commandBlocker(
  command: RegisteredCommand,
  binding: MenuBinding,
  ctx: SlashContext,
): string | null {
  if (ctx.readOnly && command.readOnlySafe !== true) return READ_ONLY_HERE;
  if (!isAvailable(command, { consoles: ctx.consoles ?? [] })) return NOT_YOURS;
  if (binding.onSelect === undefined && binding.choices === undefined) return NOT_HERE;
  return binding.blocker ?? null;
}

/**
 * Every registered action with a `/` word, in registry order with the navigation ones last. Each
 * is known whether or not something binds it now: an unbound one (a draft thread, a control not
 * read yet), one a reader may not use, or one the binding blocks is listed with the reason, so a
 * known word is never sent to the agent as a message (CE22).
 */
export function slashEntries(bindings: MenuBindings, ctx: SlashContext): readonly SlashEntry[] {
  const all = COMMANDS.flatMap((command) => {
    const slash = command.slash;
    if (slash === undefined) return [];
    const binding = bindings[command.id] ?? UNBOUND;
    const label = binding.label ?? command.name;
    return [{ command, slash, label, binding, blocker: commandBlocker(command, binding, ctx) }];
  });
  return [...all.filter((e) => e.command.href === undefined), ...all.filter((e) => e.command.href)];
}

const commandItem = (e: SlashEntry): TriggerItem => ({
  id: e.command.id,
  type: SLASH_COMMAND,
  label: `${SLASH_TRIGGER}${e.slash}`,
  description: e.label,
  metadata: { arg: e.command.arg ?? null, blocker: e.blocker },
});

/** One disabled row for a known word whose argument matches nothing: Enter sends nothing. */
const noMatch = (e: SlashEntry, reason: string): TriggerItem => ({
  id: `${e.command.id}:${SLASH_NO_MATCH}`,
  type: SLASH_NO_MATCH,
  label: reason,
  metadata: { command: e.command.id, blocker: reason },
});

/**
 * The menu's items for `query`: the actions whose word starts with what is typed; after a known
 * word and a space, that action's argument choices matching the rest. A known word whose argument
 * matches nothing (or that takes none) gets one disabled "no match" row, so the menu stays open
 * and nothing is sent. Empty only for a word no action has: the text is then a message.
 */
export function slashItems(
  query: SlashQuery,
  entries: readonly SlashEntry[],
): readonly TriggerItem[] {
  const name = query.name.toLowerCase();
  const pi = piWord(name, entries);
  if (pi?.kind === "refused") return [pi.row];
  if (query.arg === undefined) {
    const found = entries.filter((e) => e.slash.startsWith(name));
    const offered = pi?.kind === "alias" && !found.includes(pi.entry) ? [pi.entry] : [];
    return [...found, ...offered].map(commandItem);
  }
  const entry =
    entries.find((e) => e.slash === name) ?? (pi?.kind === "alias" ? pi.entry : undefined);
  if (entry === undefined) return [];
  if (entry.blocker !== null) return [commandItem(entry)];
  const want = query.arg.trim().toLowerCase();
  const choices = entry.binding.choices;
  if (choices === undefined) {
    return want === ""
      ? [commandItem(entry)]
      : [noMatch(entry, `${SLASH_TRIGGER}${entry.slash} takes no argument.`)];
  }
  if (choices.length === 0) return [noMatch(entry, "Nothing to choose from right now.")];
  const found = choices.filter(
    (c) => c.label.toLowerCase().includes(want) || c.key.toLowerCase().startsWith(want),
  );
  if (found.length === 0) {
    return [noMatch(entry, `No ${entry.command.arg ?? "choice"} matches “${query.arg.trim()}”.`)];
  }
  return found.map((c) => ({
    id: `${entry.command.id}:${c.key}`,
    type: SLASH_ARGUMENT,
    label: c.label,
    description: c.current === true ? "current" : undefined,
    metadata: { command: entry.command.id, key: c.key, blocker: null },
  }));
}

/**
 * A Pi built-in command typed in full (KOBE-450) whose word no Kobe command has: Kobe's command
 * for it (`/name` offers `/rename`), or one disabled row saying why it isn't offered, so the word
 * is neither run by Pi nor sent to it as a message.
 */
function piWord(
  name: string,
  entries: readonly SlashEntry[],
):
  | { readonly kind: "alias"; readonly entry: SlashEntry }
  | { readonly kind: "refused"; readonly row: TriggerItem }
  | undefined {
  const pi = piCommand(name);
  if (pi === undefined || entries.some((e) => e.slash === name)) return undefined;
  const m = pi.mapping;
  if (m.kind === "not-offered") {
    const label = notOfferedLabel(pi.word, m.reason);
    return {
      kind: "refused",
      row: { id: `pi:${pi.word}`, type: SLASH_NO_MATCH, label, metadata: { blocker: label } },
    };
  }
  const entry = entries.find((e) => e.command.id === m.command);
  return entry === undefined ? undefined : { kind: "alias", entry };
}

/** What a pick does. */
export type SlashOutcome =
  | { readonly kind: "run"; readonly run: () => void }
  /** The action takes an argument: the composer gets `text` and the menu lists its choices. */
  | { readonly kind: "complete"; readonly text: string }
  /** Nothing runs and nothing is sent: the text stays, with the reason. */
  | { readonly kind: "blocked"; readonly reason: string };

export function slashOutcome(item: TriggerItem, entries: readonly SlashEntry[]): SlashOutcome {
  if (item.type === SLASH_NO_MATCH) return { kind: "blocked", reason: item.label };
  const id = item.type === SLASH_COMMAND ? item.id : item.metadata?.["command"];
  const entry = entries.find((e) => e.command.id === id);
  if (entry === undefined) return { kind: "blocked", reason: NOT_HERE };
  if (entry.blocker !== null)
    return { kind: "blocked", reason: `${entry.label}: ${entry.blocker}` };
  const { binding } = entry;
  if (item.type === SLASH_ARGUMENT) {
    const choice = binding.choices?.find((c) => c.key === item.metadata?.["key"]);
    return choice ? { kind: "run", run: choice.onSelect } : { kind: "blocked", reason: NOT_HERE };
  }
  if (binding.choices !== undefined) {
    return { kind: "complete", text: `${SLASH_TRIGGER}${entry.slash} ` };
  }
  return binding.onSelect
    ? { kind: "run", run: binding.onSelect }
    : { kind: "blocked", reason: NOT_HERE };
}

/** Bindings for the navigation commands that have a `/` word: they go where their link goes. */
export function hrefBindings(go: (href: string) => void): MenuBindings {
  return Object.fromEntries(
    COMMANDS.flatMap((c) => {
      const href = c.href;
      return c.slash === undefined || href === undefined
        ? []
        : [[c.id, { onSelect: () => go(href) } satisfies MenuBinding]];
    }),
  );
}
