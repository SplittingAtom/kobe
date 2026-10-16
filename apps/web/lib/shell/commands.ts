import {
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BellIcon,
  BotIcon,
  BrainIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CircleUserIcon,
  CircleXIcon,
  ClipboardCopyIcon,
  CopyIcon,
  CornerDownRightIcon,
  DownloadIcon,
  EllipsisIcon,
  EllipsisVerticalIcon,
  ExternalLinkIcon,
  FoldVerticalIcon,
  FolderIcon,
  FolderKanbanIcon,
  GitForkIcon,
  GripVerticalIcon,
  MessagesSquareIcon,
  MicIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightOpenIcon,
  PaperclipIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RefreshCcwDotIcon,
  RefreshCwIcon,
  ServerCogIcon,
  SquareIcon,
  SquarePenIcon,
  SunIcon,
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

/**
 * Where the command's icon sits. `thread`: the conversation's own chrome (banner, jump pill).
 * `thread-menu` and `file-menu`: the items of the rail's row menus (KOBE-292, `ActionMenu`), in
 * registry order; a row binds the ones it offers (`lib/shell/menu.ts`).
 */
export type CommandScope =
  "bar" | "rail" | "thread" | "message" | "composer" | "artifact" | "thread-menu" | "file-menu";

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
  /** Bar links render in two navs: the member's areas and the consoles. */
  readonly group?: "areas" | "consoles";
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
  {
    id: "my-memory",
    group: "areas",
    name: "My memory",
    icon: BrainIcon,
    scope: "bar",
    href: "/me/memory",
  },
  {
    id: "my-schedules",
    group: "areas",
    name: "My schedules",
    icon: CalendarClockIcon,
    scope: "bar",
    href: "/me/schedules",
  },
  {
    id: "my-agents",
    group: "areas",
    name: "My agents",
    icon: BotIcon,
    scope: "bar",
    href: "/me/agents",
  },
  {
    id: "team-console",
    group: "consoles",
    name: "Team console",
    icon: UsersIcon,
    scope: "bar",
    href: consoleHref("team"),
    available: (ctx) => ctx.consoles.includes("team"),
  },
  {
    id: "site-console",
    group: "consoles",
    name: "Site console",
    icon: ServerCogIcon,
    scope: "bar",
    href: consoleHref("site"),
    available: (ctx) => ctx.consoles.includes("site"),
  },
  { id: "notifications", name: "Notifications", icon: BellIcon, scope: "bar" },
  { id: "profile", name: "Profile", icon: CircleUserIcon, scope: "bar" },
  // KOBE-282: flips light/dark; a toggle (aria-pressed while dark). The call site shows the
  // current theme's icon, sun or moon.
  { id: "theme", name: "Dark theme", icon: SunIcon, scope: "bar" },
  // Bar, row two: the open thread's context. Files shows the rail's Files section.
  { id: "files", name: "Files", icon: FolderIcon, scope: "bar", shortcut: "Mod+Shift+F" },
  // CE12 (KOBE-208): opens or closes every reasoning block and tool card; a toggle (aria-pressed).
  {
    id: "detail",
    name: "Show all details",
    icon: ChevronsUpDownIcon,
    scope: "bar",
    shortcut: "Mod+Shift+D",
  },
  // Compact now (CE15, B9 KOBE-213): beside the context gauge at red, and in the thread's actions
  // menu; opens the dialog (optional focus). Enabled only while the thread is idle. It acts on the
  // conversation, and the bar's scope lists only icons the bar always shows. `/compact`: C6.
  { id: "compact-thread", name: "Compact this thread", icon: FoldVerticalIcon, scope: "thread" },
  // The open thread's actions menu in bar row two (on one column, inside the bar's Menu).
  { id: "thread-actions", name: "Conversation actions", icon: EllipsisIcon, scope: "thread" },
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
    name: "Collapse the rail",
    icon: PanelLeftCloseIcon,
    scope: "rail",
    shortcut: "Mod+B",
  },
  // The collapsed rail (48 px): new thread (above), threads and files; each expands it.
  { id: "show-threads", name: "Show threads", icon: MessagesSquareIcon, scope: "rail" },
  { id: "show-files", name: "Show files", icon: FolderIcon, scope: "rail" },
  // Under 768 px the rail is a drawer the bar opens (CE8, KOBE-201).
  { id: "open-rail", name: "Show the workspace", icon: PanelLeftOpenIcon, scope: "rail" },
  { id: "refresh-files", name: "Refresh files", icon: RefreshCwIcon, scope: "rail" },
  // A thread row's ⋯ menu button (KOBE-292; the call site names the thread: "Actions for Budget").
  { id: "thread-row-actions", name: "Thread actions", icon: EllipsisIcon, scope: "rail" },
  // Trash rows keep their two icons.
  { id: "restore-thread", name: "Restore", icon: ArchiveRestoreIcon, scope: "rail" },
  { id: "delete-thread", name: "Delete forever", icon: CircleXIcon, scope: "rail" },
  { id: "export-threads", name: "Export my conversations", icon: DownloadIcon, scope: "rail" },
  // A Files row's ⋯ menu button (the call site names the file: "Actions for report.csv").
  { id: "file-row-actions", name: "File actions", icon: EllipsisIcon, scope: "rail" },
  // The thread row's menu (KOBE-292), in menu order. KOBE-220 adds Pin, Archive and Move here.
  // Copy: the branch on screen as Markdown. Regenerate (with): the thread's last answer.
  { id: "copy-thread", name: "Copy", icon: CopyIcon, scope: "thread-menu" },
  { id: "regenerate-thread", name: "Regenerate", icon: RefreshCwIcon, scope: "thread-menu" },
  {
    id: "regenerate-thread-with",
    name: "Regenerate with",
    icon: RefreshCcwDotIcon,
    scope: "thread-menu",
  },
  // Delete moves the thread to Trash (D18), after a confirm.
  { id: "trash-thread", name: "Delete", icon: Trash2Icon, scope: "thread-menu" },
  // A Files row's menu (KOBE-292). The workspace API has no rename or move yet.
  { id: "open-file", name: "Open", icon: ExternalLinkIcon, scope: "file-menu" },
  { id: "download-file", name: "Download", icon: DownloadIcon, scope: "file-menu" },
  { id: "copy-file-path", name: "Copy path", icon: ClipboardCopyIcon, scope: "file-menu" },
  { id: "delete-file", name: "Delete", icon: Trash2Icon, scope: "file-menu" },
  // The conversation's chrome. Rename: the pencil beside the header's title (KOBE-292).
  { id: "rename-thread", name: "Rename", icon: PencilIcon, scope: "thread" },
  { id: "open-project", name: "Project", icon: FolderKanbanIcon, scope: "thread" },
  { id: "jump-to-latest", name: "Jump to latest", icon: ArrowDownIcon, scope: "thread" },
  // Closes a notice banner (retention, a file that left the workspace).
  { id: "dismiss-notice", name: "Dismiss", icon: XIcon, scope: "thread" },
  // Under 768 px the bar's one row ends in this menu: row two, search, areas, profile (CE8).
  { id: "thread-menu", name: "Menu", icon: EllipsisVerticalIcon, scope: "thread" },
  // Message actions.
  { id: "copy", name: "Copy", icon: CopyIcon, scope: "message" },
  { id: "edit", name: "Edit", icon: PencilIcon, scope: "message", shortcut: "Mod+Shift+E" },
  { id: "regenerate", name: "Regenerate", icon: RefreshCwIcon, scope: "message" },
  // Regenerate's split half (CE17, KOBE-217): the team's models to regenerate with.
  { id: "regenerate-with", name: "Regenerate with…", icon: ChevronDownIcon, scope: "message" },
  { id: "fork-thread", name: "Fork to a new thread", icon: GitForkIcon, scope: "message" },
  { id: "previous-branch", name: "Previous version", icon: ChevronLeftIcon, scope: "message" },
  { id: "next-branch", name: "Next version", icon: ChevronRightIcon, scope: "message" },
  { id: "copy-code", name: "Copy code", icon: CopyIcon, scope: "message" },
  { id: "open-artifact", name: "Open artifact", icon: PanelRightOpenIcon, scope: "message" },
  // Composer.
  { id: "attach", name: "Attach files", icon: PaperclipIcon, scope: "composer" },
  { id: "dictate", name: "Dictate", icon: MicIcon, scope: "composer" },
  { id: "send", name: "Send", icon: ArrowUpIcon, scope: "composer" },
  { id: "stop", name: "Stop", icon: SquareIcon, scope: "composer", shortcut: "Mod+." },
  // The steering panel above the input (CE10, KOBE-206): bound in the composer while a run is on.
  {
    id: "steer",
    name: "Steer now",
    icon: CornerDownRightIcon,
    scope: "composer",
    shortcut: "Mod+Shift+Enter",
  },
  { id: "pause-queue", name: "Pause the queue", icon: PauseIcon, scope: "composer" },
  { id: "resume-queue", name: "Resume queue", icon: PlayIcon, scope: "composer" },
  { id: "move-queued", name: "Move queued message", icon: GripVerticalIcon, scope: "composer" },
  { id: "delete-queued", name: "Delete queued message", icon: XIcon, scope: "composer" },
  // Artifact column.
  {
    id: "artifact-previous",
    name: "Previous version",
    icon: ChevronLeftIcon,
    scope: "artifact",
  },
  { id: "artifact-next", name: "Next version", icon: ChevronRightIcon, scope: "artifact" },
  { id: "artifact-download", name: "Download", icon: DownloadIcon, scope: "artifact" },
  { id: "artifact-close", name: "Close artifact", icon: XIcon, scope: "artifact" },
  // The artifact sheet (under 820 px) goes back to the conversation; its tabs stay open.
  { id: "artifact-back", name: "Back to the conversation", icon: ArrowLeftIcon, scope: "artifact" },
] as const satisfies readonly Command[];

export type CommandId = (typeof LIST)[number]["id"];

/** A command of this registry: its id is known to the type system. */
export type RegisteredCommand = Command & { readonly id: CommandId };

export const COMMANDS: readonly RegisteredCommand[] = LIST;

const BY_ID: ReadonlyMap<string, RegisteredCommand> = new Map(LIST.map((c) => [c.id, c]));

export function command(id: CommandId): RegisteredCommand {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown command: ${id}`);
  return found;
}

export function isAvailable(cmd: Command, ctx: CommandContext): boolean {
  return cmd.available?.(ctx) ?? true;
}

/** The commands of one scope available in `ctx`, in registry order. */
export function commandsIn(scope: CommandScope, ctx: CommandContext): readonly RegisteredCommand[] {
  return COMMANDS.filter((c) => c.scope === scope && isAvailable(c, ctx));
}

const MAC_KEYS: Readonly<Record<string, string>> = {
  Mod: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Escape: "Esc",
};
const OTHER_KEYS: Readonly<Record<string, string>> = { Mod: "Ctrl", Escape: "Esc" };
const ARIA_KEYS: Readonly<Record<string, string>> = { Ctrl: "Control" };

/** `Mod+Shift+F` → `["Mod", "Shift", "F"]`; a trailing `+` is the plus key itself. */
function keysOf(shortcut: string): readonly string[] {
  const keys = shortcut.split("+");
  return keys.at(-1) === "" ? [...keys.slice(0, -2), "+"] : keys;
}

/**
 * A shortcut as the platform writes it: macOS runs the symbols together (`⌘⇧F`, `⌃K`, `⇧?`),
 * other systems join names with `+` (`Ctrl+Shift+F`). `Escape` is `Esc` on both.
 */
export function formatShortcut(shortcut: string, mac: boolean): string {
  const keys = keysOf(shortcut);
  return mac
    ? keys.map((k) => MAC_KEYS[k] ?? k).join("")
    : keys.map((k) => OTHER_KEYS[k] ?? k).join("+");
}

/**
 * The `aria-keyshortcuts` value. A `Mod` shortcut names both platforms' forms (`Control+N Meta+N`),
 * so server and client render the same; any other shortcut is one value (`Control+K`, `Escape`).
 */
export function ariaKeyShortcuts(shortcut: string): string {
  const keys = keysOf(shortcut).map((k) => ARIA_KEYS[k] ?? k);
  if (!keys.includes("Mod")) return keys.join("+");
  return ["Control", "Meta"]
    .map((mod) => keys.map((k) => (k === "Mod" ? mod : k)).join("+"))
    .join(" ");
}
