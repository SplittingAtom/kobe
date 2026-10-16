/**
 * The rail's row menus (KOBE-292): a menu is a scope of the command registry (`thread-menu`,
 * `file-menu`), and a row binds the commands it offers (what they do, whether they can run now).
 * `ActionMenu` renders the bound ones in registry order. KOBE-220 adds Pin, Archive and Move by
 * registering them in `thread-menu` and binding them in the thread row.
 */
import { COMMANDS, type CommandId, type RegisteredCommand } from "./commands";

export type MenuScope = "thread-menu" | "file-menu";

/** One entry of a submenu (a model to regenerate with). */
export interface MenuChoice {
  readonly key: string;
  readonly label: string;
  /** The current choice, marked "(current)" as on the answers' menu (KOBE-217). */
  readonly current?: boolean | undefined;
  readonly onSelect: () => void;
}

export interface MenuBinding {
  /** Replaces the registry's name ("Delete folder"). */
  readonly label?: string | undefined;
  /** Why it can't run now: shown as its tooltip and description; the item stays focusable. */
  readonly blocker?: string | null | undefined;
  readonly onSelect?: (() => void) | undefined;
  /** A submenu instead of an action (Regenerate with's models). */
  readonly choices?: readonly MenuChoice[] | undefined;
  /** Painted as destructive (Delete). */
  readonly destructive?: boolean | undefined;
  /**
   * It opens something that takes the focus (a confirm): it runs once the menu has closed, and
   * the menu doesn't give the focus back to its button.
   */
  readonly movesFocus?: boolean | undefined;
}

export type MenuBindings = Partial<Readonly<Record<CommandId, MenuBinding>>>;

export interface MenuItem extends MenuBinding {
  readonly command: RegisteredCommand;
  readonly label: string;
}

/** The commands of `scope` the row binds, in registry order. */
export function menuItems(scope: MenuScope, bindings: MenuBindings): readonly MenuItem[] {
  return COMMANDS.flatMap((command) => {
    const binding = command.scope === scope ? bindings[command.id] : undefined;
    return binding ? [{ ...binding, command, label: binding.label ?? command.name }] : [];
  });
}
