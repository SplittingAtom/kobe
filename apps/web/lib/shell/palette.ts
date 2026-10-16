/**
 * The command palette (CE23, KOBE-225), its pure half. Ctrl/Cmd+K lists, in one grouped list, the
 * registry's actions, thread titles and workspace file names. Actions run through their live
 * bindings (`useBindCommands`) under the `/` menu's rules (`commandBlocker`): a known action that
 * can't run now is listed with its reason, and picking it does nothing. An action whose binding
 * offers choices (Regenerate with's models, Move's projects) opens them as a second step.
 */
import { COMMANDS, type CommandId, type RegisteredCommand } from "./commands";
import type { MenuBinding, MenuBindings, MenuChoice } from "./menu";
import { commandBlocker, type SlashContext } from "./slash";

export interface PaletteAction {
  readonly command: RegisteredCommand;
  readonly label: string;
  readonly binding: MenuBinding;
  /** Why it can't run now; null when it can. */
  readonly blocker: string | null;
}

/** The palette's own command is not listed in it. */
const SELF: CommandId = "command-palette";

const listed = (c: RegisteredCommand) =>
  c.id !== SELF &&
  (c.slash !== undefined || c.shortcut !== undefined || c.href !== undefined || c.palette === true);

const UNBOUND: MenuBinding = {};

/**
 * Every action the palette offers, bound or not, in registry order with navigation last (as the
 * `/` menu): those with a `/` word, a shortcut, a link, or marked for the palette.
 */
export function paletteActions(
  bindings: MenuBindings,
  ctx: SlashContext,
): readonly PaletteAction[] {
  const all = COMMANDS.filter(listed).map((command) => {
    const binding = bindings[command.id] ?? UNBOUND;
    return {
      command,
      label: binding.label ?? command.name,
      binding,
      blocker: commandBlocker(command, binding, ctx),
    };
  });
  return [...all.filter((a) => a.command.href === undefined), ...all.filter((a) => a.command.href)];
}

const words = (text: string) => text.toLowerCase().split(/\s+/u).filter(Boolean);

/** Whether every word of `query` is in `text` (case-insensitive); an empty query matches all. */
export function matchesQuery(text: string, query: string): boolean {
  const hay = text.toLowerCase();
  return words(query).every((w) => hay.includes(w));
}

/** The actions matching `query` by label, registry name or `/` word. */
export function filterActions(
  actions: readonly PaletteAction[],
  query: string,
): readonly PaletteAction[] {
  return actions.filter((a) =>
    matchesQuery([a.label, a.command.name, a.command.slash ?? ""].join(" "), query),
  );
}

export function filterChoices(choices: readonly MenuChoice[], query: string) {
  return choices.filter((c) => matchesQuery(`${c.label} ${c.key}`, query));
}

export type PaletteOutcome =
  | { readonly kind: "run"; readonly run: () => void }
  /** The action takes an argument: the palette lists its choices next. */
  | { readonly kind: "choose"; readonly action: PaletteAction }
  /** Nothing runs: the palette stays open and says why. */
  | { readonly kind: "blocked"; readonly reason: string };

export function paletteOutcome(action: PaletteAction): PaletteOutcome {
  if (action.blocker !== null) {
    return { kind: "blocked", reason: `${action.label}: ${action.blocker}` };
  }
  if (action.binding.choices !== undefined) {
    return action.binding.choices.length === 0
      ? { kind: "blocked", reason: `${action.label}: Nothing to choose from right now.` }
      : { kind: "choose", action };
  }
  const run = action.binding.onSelect;
  return run ? { kind: "run", run } : { kind: "blocked", reason: action.label };
}

/** Bindings for every navigation command: it goes where its link goes. */
export function navigationBindings(go: (href: string) => void): MenuBindings {
  return Object.fromEntries(
    COMMANDS.flatMap((c) => {
      const href = c.href;
      return href === undefined ? [] : [[c.id, { onSelect: () => go(href) } satisfies MenuBinding]];
    }),
  );
}
