import {
  ArchiveRestoreIcon,
  BellIcon,
  BotIcon,
  BrainIcon,
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleUserIcon,
  CircleXIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  PanelLeftIcon,
  PanelRightOpenIcon,
  PencilIcon,
  RefreshCwIcon,
  ServerCogIcon,
  SquarePenIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { consoleHref } from "../admin/nav/paths";
import type { ConsoleKind } from "../admin/nav/types";

/**
 * The command registry (CE13, KOBE-203): every navigation and action icon in the chat shell is one
 * entry here, rendered by `IconAction` (`components/shell/icon-action.tsx`). The `/` menu (CE22,
 * KOBE-224) and the palette (CE23, KOBE-225) read the same list later.
 *
 * Handlers: a navigation command carries its `href`. The others are bound where they render
 * (assistant-ui's action-bar and thread-list primitives own copy, edit, regenerate, rename, Trash),
 * because they act on the message or thread on screen; C6/C7 add a handler map for the palette.
 */

/** Where the command's icon sits. */
export type CommandScope = "bar" | "rail" | "message" | "artifact";

/** What availability depends on; grows with the palette (thread state, selection). */
export interface CommandContext {
  /** The consoles the server opens to the caller (`useOpenConsoles`). */
  readonly consoles: readonly ConsoleKind[];
}

export interface Command {
  readonly id: string;
  /** The tooltip and the accessible label (a call site may add the object: "Rename Budget"). */
  readonly name: string;
  readonly icon: LucideIcon;
  readonly scope: CommandScope;
  /** CE23 notation: `Mod` is Cmd on macOS and Ctrl elsewhere, e.g. `Mod+Shift+F`. */
  readonly shortcut?: string;
  /** Navigation commands: where they go. */
  readonly href?: string;
  /** Absent means always available. */
  readonly available?: (ctx: CommandContext) => boolean;
}

/**
 * The CE23 shortcuts are recorded here but not bound yet: C7 (KOBE-225) adds the key handlers and
 * turns this on, so tooltips don't promise keys that do nothing until then.
 */
export const SHORTCUTS_BOUND = false;

const LIST = [
  // Bar, row one: the member's areas, the consoles, notifications, profile.
  { id: "my-memory", name: "My memory", icon: BrainIcon, scope: "bar", href: "/me/memory" },
  {
    id: "my-schedules",
    name: "My schedules",
    icon: CalendarClockIcon,
    scope: "bar",
    href: "/me/schedules",
  },
  { id: "my-agents", name: "My agents", icon: BotIcon, scope: "bar", href: "/me/agents" },
  {
    id: "team-console",
    name: "Team console",
    icon: UsersIcon,
    scope: "bar",
    href: consoleHref("team"),
    available: (ctx) => ctx.consoles.includes("team"),
  },
  {
    id: "site-console",
    name: "Site console",
    icon: ServerCogIcon,
    scope: "bar",
    href: consoleHref("site"),
    available: (ctx) => ctx.consoles.includes("site"),
  },
  { id: "notifications", name: "Notifications", icon: BellIcon, scope: "bar" },
  { id: "profile", name: "Profile", icon: CircleUserIcon, scope: "bar" },
  // Bar, row two: the open thread's context.
  { id: "files", name: "Files", icon: FolderIcon, scope: "bar", shortcut: "Mod+Shift+F" },
  // Rail.
  {
    id: "new-thread",
    name: "New conversation",
    icon: SquarePenIcon,
    scope: "rail",
    shortcut: "Mod+N",
  },
  {
    id: "toggle-rail",
    name: "Conversations",
    icon: PanelLeftIcon,
    scope: "rail",
    shortcut: "Mod+B",
  },
  { id: "rename-thread", name: "Rename", icon: PencilIcon, scope: "rail" },
  { id: "trash-thread", name: "Move to Trash", icon: Trash2Icon, scope: "rail" },
  { id: "restore-thread", name: "Restore", icon: ArchiveRestoreIcon, scope: "rail" },
  { id: "delete-thread", name: "Delete forever", icon: CircleXIcon, scope: "rail" },
  { id: "export-threads", name: "Export my conversations", icon: DownloadIcon, scope: "rail" },
  // Message actions.
  { id: "copy", name: "Copy", icon: CopyIcon, scope: "message" },
  { id: "edit", name: "Edit", icon: PencilIcon, scope: "message", shortcut: "Mod+Shift+E" },
  { id: "regenerate", name: "Regenerate", icon: RefreshCwIcon, scope: "message" },
  { id: "previous-branch", name: "Previous version", icon: ChevronLeftIcon, scope: "message" },
  { id: "next-branch", name: "Next version", icon: ChevronRightIcon, scope: "message" },
  { id: "open-artifact", name: "Open artifact", icon: PanelRightOpenIcon, scope: "message" },
  // Artifact column (artifact and files panels).
  {
    id: "artifact-previous",
    name: "Previous version",
    icon: ChevronLeftIcon,
    scope: "artifact",
  },
  { id: "artifact-next", name: "Next version", icon: ChevronRightIcon, scope: "artifact" },
  { id: "artifact-download", name: "Download", icon: DownloadIcon, scope: "artifact" },
  { id: "artifact-close", name: "Close artifact", icon: XIcon, scope: "artifact" },
  { id: "files-close", name: "Close files", icon: XIcon, scope: "artifact" },
] as const satisfies readonly Command[];

export type CommandId = (typeof LIST)[number]["id"];

export const COMMANDS: readonly Command[] = LIST;

const BY_ID: ReadonlyMap<string, Command> = new Map(LIST.map((c) => [c.id, c]));

export function command(id: CommandId): Command {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown command: ${id}`);
  return found;
}

export function isAvailable(cmd: Command, ctx: CommandContext): boolean {
  return cmd.available?.(ctx) ?? true;
}

/** The commands of one scope available in `ctx`, in registry order. */
export function commandsIn(scope: CommandScope, ctx: CommandContext): readonly Command[] {
  return COMMANDS.filter((c) => c.scope === scope && isAvailable(c, ctx));
}

/** A shortcut as the platform writes it: `⌘⇧F` on macOS, `Ctrl+Shift+F` elsewhere. */
export function formatShortcut(shortcut: string, mac: boolean): string {
  const keys = shortcut.split("+");
  if (!mac) return keys.map((k) => (k === "Mod" ? "Ctrl" : k)).join("+");
  const MAC: Readonly<Record<string, string>> = { Mod: "⌘", Shift: "⇧", Alt: "⌥" };
  return keys.map((k) => MAC[k] ?? k).join("");
}

/** `aria-keyshortcuts` names both platforms' forms, so it is the same on server and client. */
export function ariaKeyShortcuts(shortcut: string): string {
  return ["Control", "Meta"].map((mod) => shortcut.replace("Mod", mod)).join(" ");
}
