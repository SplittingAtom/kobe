/**
 * The `/` actions menu (CE22, KOBE-224), its pure half. Typing `/` at the start of the composer
 * lists the registry's commands that have a `slash` word and a live binding (`MenuBinding`,
 * published by the component that owns the action), so a pick runs the very handler the button
 * runs. Nothing is ever sent to Pi as a command: a pick removes the `/` text, and an unknown word
 * lists nothing, so the text goes as an ordinary message.
 */
import type { TriggerItem, TriggerMatcher } from "@assistant-ui/react";
import { COMMANDS, type RegisteredCommand } from "./commands";
import type { MenuBinding, MenuBindings } from "./menu";

export const SLASH_TRIGGER = "/";
/** `TriggerItem.type` of an action, and of one of its argument's choices. */
export const SLASH_COMMAND = "command";
export const SLASH_ARGUMENT = "argument";

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

export interface SlashEntry {
  readonly command: RegisteredCommand;
  readonly slash: string;
  readonly label: string;
  readonly binding: MenuBinding;
}

export interface SlashContext {
  /** The thread is shared with the viewer read-only (KOBE-221). */
  readonly readOnly: boolean;
}

/**
 * The actions the menu offers, in registry order: a `slash` word and a binding that runs
 * (`onSelect`) or takes an argument (`choices`). A reader gets only the read-only-safe ones.
 */
export function slashEntries(bindings: MenuBindings, ctx: SlashContext): readonly SlashEntry[] {
  return COMMANDS.flatMap((command) => {
    const binding = bindings[command.id];
    const slash = command.slash;
    if (slash === undefined || binding === undefined) return [];
    if (binding.onSelect === undefined && binding.choices === undefined) return [];
    if (ctx.readOnly && command.readOnlySafe !== true) return [];
    return [{ command, slash, label: binding.label ?? command.name, binding }];
  });
}

const commandItem = (e: SlashEntry): TriggerItem => ({
  id: e.command.id,
  type: SLASH_COMMAND,
  label: `${SLASH_TRIGGER}${e.slash}`,
  description: e.label,
  metadata: { arg: e.command.arg ?? null, blocker: e.binding.blocker ?? null },
});

/**
 * The menu's items for `query`: the actions whose word starts with what is typed; after the word
 * and a space, that action's argument choices matching the rest (an action without an argument
 * matches only while nothing follows the space). Empty for an unknown word: the menu stays shut.
 */
export function slashItems(
  query: SlashQuery,
  entries: readonly SlashEntry[],
): readonly TriggerItem[] {
  const name = query.name.toLowerCase();
  if (query.arg === undefined) {
    return entries.filter((e) => e.slash.startsWith(name)).map(commandItem);
  }
  const entry = entries.find((e) => e.slash === name);
  if (entry === undefined) return [];
  const choices = entry.binding.choices;
  if (choices === undefined) return query.arg.trim() === "" ? [commandItem(entry)] : [];
  const want = query.arg.trim().toLowerCase();
  return choices
    .filter((c) => c.label.toLowerCase().includes(want) || c.key.toLowerCase().startsWith(want))
    .map((c) => ({
      id: `${entry.command.id}:${c.key}`,
      type: SLASH_ARGUMENT,
      label: c.label,
      description: c.current === true ? "current" : undefined,
      metadata: { command: entry.command.id, key: c.key, blocker: entry.binding.blocker ?? null },
    }));
}

/** What a pick does. */
export type SlashOutcome =
  | { readonly kind: "run"; readonly run: () => void }
  /** The action takes an argument: the composer gets `text` and the menu lists its choices. */
  | { readonly kind: "complete"; readonly text: string }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "none" };

const NONE: SlashOutcome = { kind: "none" };

export function slashOutcome(item: TriggerItem, entries: readonly SlashEntry[]): SlashOutcome {
  const id = item.type === SLASH_ARGUMENT ? item.metadata?.["command"] : item.id;
  const entry = entries.find((e) => e.command.id === id);
  if (entry === undefined) return NONE;
  const { binding } = entry;
  if (binding.blocker != null)
    return { kind: "blocked", reason: `${entry.label}: ${binding.blocker}` };
  if (item.type === SLASH_ARGUMENT) {
    const key = item.metadata?.["key"];
    const choice = binding.choices?.find((c) => c.key === key);
    return choice ? { kind: "run", run: choice.onSelect } : NONE;
  }
  if (binding.choices !== undefined) {
    return { kind: "complete", text: `${SLASH_TRIGGER}${entry.slash} ` };
  }
  return binding.onSelect ? { kind: "run", run: binding.onSelect } : NONE;
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
