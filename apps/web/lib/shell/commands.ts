import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  AtSignIcon,
  BellIcon,
  BotIcon,
  BrainIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  CircleUserIcon,
  CircleXIcon,
  CommandIcon,
  ClipboardCopyIcon,
  CopyIcon,
  CpuIcon,
  CornerDownRightIcon,
  DownloadIcon,
  EllipsisIcon,
  EllipsisVerticalIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderInputIcon,
  FolderKanbanIcon,
  GitForkIcon,
  GripVerticalIcon,
  KeyboardIcon,
  MessagesSquareIcon,
  MicIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightIcon,
  PanelRightOpenIcon,
  PaperclipIcon,
  PauseIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  RefreshCcwDotIcon,
  RefreshCwIcon,
  ServerCogIcon,
  Share2Icon,
  ShrinkIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  SquarePenIcon,
  SunIcon,
  TextCursorInputIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
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
 * because they act on the message or thread on screen. A component that owns an action also
 * publishes its binding (`MenuBinding`: handler, blocker, argument choices) with
 * `useBindCommands` (`components/shell/command-bindings.tsx`); the `/` menu (KOBE-224) and the
 * palette (KOBE-225) run those same bindings. A command with a `slash` word is offered there.
 */

/**
 * Where the command's icon sits. `thread`: the conversation's own chrome (banner, jump pill).
 * `thread-menu` and `file-menu`: the items of the rail's row menus (KOBE-292, `ActionMenu`), in
 * registry order; a row binds the ones it offers (`lib/shell/menu.ts`).
 */
export type CommandScope =
  | "bar"
  | "rail"
  | "thread"
  | "message"
  | "composer"
  | "artifact"
  | "thread-menu"
  | "file-menu"
  /** Keyboard and palette only (CE23, KOBE-225): no icon of its own on screen. */
  | "app";

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
  /** A second key for the same command, where browsers keep the first (Mod+N, a new window). */
  readonly alias?: string;
  /** Navigation commands: where they go. */
  readonly href?: string;
  /** Absent means always available. */
  readonly available?: (ctx: CommandContext) => boolean;
  /** Its word in the `/` menu (CE22, KOBE-224): one lowercase word, unique in the registry. */
  readonly slash?: string;
  /** The argument it takes after its `/` word (its binding's `choices`), named for the menu. */
  readonly arg?: string;
  /** Offered to a reader of a shared thread (KOBE-221): it changes nothing of the owner's. */
  readonly readOnlySafe?: boolean;
  /**
   * Listed in the palette (CE23, KOBE-225) although it has no `/` word, shortcut or href: an
   * action of the whole app rather than of one row or message (the theme).
   */
  readonly palette?: boolean;
}

/**
 * The CE23 shortcuts are bound (KOBE-225, `components/shell/shortcut-keys.tsx`), so tooltips show
 * them. Kept as a switch so a surface without the key handlers could turn them off again.
 */
export const SHORTCUTS_BOUND = true;

const LIST = [
  // Bar: the member's areas, the consoles, notifications, profile.
  {
    id: "my-memory",
    group: "areas",
    name: "My memory",
    icon: BrainIcon,
    scope: "bar",
    href: "/me/memory",
    slash: "memory",
    readOnlySafe: true,
  },
  {
    id: "my-schedules",
    group: "areas",
    name: "My schedules",
    icon: CalendarClockIcon,
    scope: "bar",
    href: "/me/schedules",
    slash: "schedules",
    readOnlySafe: true,
  },
  {
    id: "my-agents",
    group: "areas",
    name: "My agents",
    icon: BotIcon,
    scope: "bar",
    href: "/me/agents",
    slash: "agents",
    readOnlySafe: true,
  },
  // On the rail's top line since KOBE-419 (team admins only); the palette still lists it.
  {
    id: "team-console",
    group: "consoles",
    name: "Team console",
    icon: UsersIcon,
    scope: "rail",
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
  {
    id: "theme",
    name: "Dark theme",
    icon: SunIcon,
    scope: "bar",
    palette: true,
    readOnlySafe: true,
  },
  // Shows the rail's Files section: its key, the palette and `/files`. The bar's Files button went
  // with row two (KOBE-418); the rail itself shows the section.
  {
    id: "files",
    name: "Files",
    icon: FolderIcon,
    scope: "app",
    shortcut: "Mod+Shift+F",
    slash: "files",
    readOnlySafe: true,
  },
  // CE12 (KOBE-208): opens or closes every reasoning block and tool card: its key and the palette.
  // On screen each answer has its own toggle (answer-detail, KOBE-418).
  {
    id: "detail",
    name: "Show all details",
    icon: ChevronsUpDownIcon,
    scope: "app",
    shortcut: "Mod+Shift+D",
    readOnlySafe: true,
  },
  // Compact now (CE15, B9 KOBE-213): beside the context gauge at red, and beside the latest
  // answer's thumbs down (KOBE-418, labelled "Compact now"); opens the dialog (optional focus).
  // Enabled only while the thread is idle.
  {
    id: "compact-thread",
    name: "Compact this thread",
    icon: ShrinkIcon,
    scope: "thread",
    slash: "compact",
  },
  // The conversation's model (D30): the model picker's choices, bound by `ModelPicker`.
  {
    id: "choose-model",
    name: "Model for this conversation",
    icon: CpuIcon,
    scope: "thread",
    slash: "model",
    arg: "model",
  },
  // Rail.
  {
    id: "new-thread",
    name: "New conversation",
    icon: SquarePenIcon,
    scope: "rail",
    shortcut: "Mod+N",
    alias: "Mod+Shift+O",
    slash: "new",
    readOnlySafe: true,
  },
  {
    id: "toggle-rail",
    name: "Collapse the rail",
    icon: PanelLeftCloseIcon,
    scope: "rail",
    shortcut: "Mod+B",
    readOnlySafe: true,
  },
  // The rail's top line (KOBE-419): each panel on or off; a toggle (aria-pressed). The last one on
  // stays on.
  { id: "rail-threads", name: "Threads panel", icon: MessagesSquareIcon, scope: "rail" },
  { id: "rail-files", name: "Files panel", icon: FolderIcon, scope: "rail" },
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
  // The thread row's menu (KOBE-292), in menu order. Copy: the branch on screen as Markdown.
  // Regenerate (with): the thread's last answer. Pin, Archive and Move (CE19, KOBE-220): a row
  // binds Pin or Unpin, Archive or Unarchive; Move lists the projects as a submenu.
  {
    id: "copy-thread",
    name: "Copy",
    icon: CopyIcon,
    scope: "thread-menu",
    slash: "copy",
    readOnlySafe: true,
  },
  {
    id: "regenerate-thread",
    name: "Regenerate",
    icon: RefreshCwIcon,
    scope: "thread-menu",
    slash: "regenerate",
  },
  {
    id: "regenerate-thread-with",
    name: "Regenerate with",
    icon: RefreshCcwDotIcon,
    scope: "thread-menu",
    slash: "regenerate-with",
    arg: "model",
  },
  { id: "pin-thread", name: "Pin", icon: PinIcon, scope: "thread-menu", slash: "pin" },
  { id: "unpin-thread", name: "Unpin", icon: PinOffIcon, scope: "thread-menu", slash: "unpin" },
  {
    id: "move-thread",
    name: "Move to project",
    icon: FolderInputIcon,
    scope: "thread-menu",
    slash: "move",
    arg: "project",
  },
  {
    id: "archive-thread",
    name: "Archive",
    icon: ArchiveIcon,
    scope: "thread-menu",
    slash: "archive",
  },
  {
    id: "unarchive-thread",
    name: "Unarchive",
    icon: ArchiveRestoreIcon,
    scope: "thread-menu",
    slash: "unarchive",
  },
  // Share (CE20, KOBE-221): a submenu of scopes (only you, the project's members, the team).
  {
    id: "share-thread",
    name: "Share",
    icon: Share2Icon,
    scope: "thread-menu",
    slash: "share",
    arg: "with",
  },
  // Delete moves the thread to Trash (D18): undoable, so no confirm (Delete forever asks).
  { id: "trash-thread", name: "Delete", icon: Trash2Icon, scope: "thread-menu" },
  // A Files row's menu (KOBE-292). Rename (also F2 in the tree) and Move to… (the keyboard way to
  // move, beside drag and drop) use the workspace move API (KOBE-304).
  { id: "open-file", name: "Open", icon: ExternalLinkIcon, scope: "file-menu" },
  // The keyboard way to drag a file onto the composer (KOBE-374): an @file mention (KOBE-223).
  { id: "mention-file", name: "Mention in message", icon: AtSignIcon, scope: "file-menu" },
  { id: "download-file", name: "Download", icon: DownloadIcon, scope: "file-menu" },
  { id: "rename-file", name: "Rename", icon: PencilIcon, scope: "file-menu" },
  { id: "move-file", name: "Move to…", icon: FolderInputIcon, scope: "file-menu" },
  { id: "copy-file-path", name: "Copy path", icon: ClipboardCopyIcon, scope: "file-menu" },
  { id: "delete-file", name: "Delete", icon: Trash2Icon, scope: "file-menu" },
  // The conversation's chrome. Rename: the pencil beside the header's title (KOBE-292).
  { id: "rename-thread", name: "Rename", icon: PencilIcon, scope: "thread", slash: "rename" },
  { id: "open-project", name: "Project", icon: FolderKanbanIcon, scope: "thread" },
  { id: "jump-to-latest", name: "Jump to latest", icon: ArrowDownIcon, scope: "thread" },
  // Closes a notice banner (retention, a file that left the workspace).
  { id: "dismiss-notice", name: "Dismiss", icon: XIcon, scope: "thread" },
  // Under 768 px the bar ends in this menu: search, areas, profile (CE8).
  { id: "thread-menu", name: "Menu", icon: EllipsisVerticalIcon, scope: "thread" },
  // Message actions.
  { id: "copy", name: "Copy", icon: CopyIcon, scope: "message" },
  // The last user message's Edit shows the shortcut of `edit-last-message` (KOBE-225).
  { id: "edit", name: "Edit", icon: PencilIcon, scope: "message" },
  { id: "regenerate", name: "Regenerate", icon: RefreshCwIcon, scope: "message" },
  // Regenerate's split half (CE17, KOBE-217): the team's models to regenerate with.
  { id: "regenerate-with", name: "Regenerate with…", icon: ChevronDownIcon, scope: "message" },
  // `/fork` forks at the thread's last answer (KOBE-224); a reader may fork a shared thread.
  {
    id: "fork-thread",
    name: "Fork to a new thread",
    icon: GitForkIcon,
    scope: "message",
    slash: "fork",
    readOnlySafe: true,
  },
  // Answer feedback (KOBE-275): each member rates for themselves, a reader of a shared thread too.
  { id: "rate-up", name: "Good answer", icon: ThumbsUpIcon, scope: "message", readOnlySafe: true },
  {
    id: "rate-down",
    name: "Bad answer",
    icon: ThumbsDownIcon,
    scope: "message",
    readOnlySafe: true,
  },
  // One answer's reasoning and tool cards (KOBE-418), beside Fork; a toggle (aria-pressed).
  {
    id: "answer-detail",
    name: "Show details",
    icon: ChevronsUpDownIcon,
    scope: "message",
    readOnlySafe: true,
  },
  { id: "previous-branch", name: "Previous version", icon: ChevronLeftIcon, scope: "message" },
  { id: "next-branch", name: "Next version", icon: ChevronRightIcon, scope: "message" },
  { id: "copy-code", name: "Copy code", icon: CopyIcon, scope: "message" },
  { id: "open-artifact", name: "Open artifact", icon: PanelRightOpenIcon, scope: "message" },
  // Composer.
  { id: "attach", name: "Attach files", icon: PaperclipIcon, scope: "composer" },
  // A narrow composer folds its Agent, Model and Thinking selectors into this menu (KOBE-418).
  {
    id: "conversation-settings",
    name: "Agent and model",
    icon: SlidersHorizontalIcon,
    scope: "composer",
  },
  { id: "dictate", name: "Dictate", icon: MicIcon, scope: "composer" },
  { id: "send", name: "Send", icon: ArrowUpIcon, scope: "composer" },
  {
    id: "stop",
    name: "Stop",
    icon: SquareIcon,
    scope: "composer",
    shortcut: "Mod+.",
    slash: "stop",
  },
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
  // Mod+Shift+E, and Up arrow in an empty composer (CE23, KOBE-225): the last sent message.
  {
    id: "edit-last-message",
    name: "Edit your last message",
    icon: PencilIcon,
    scope: "composer",
    shortcut: "Mod+Shift+E",
  },
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
  // A My area page beside the thread (CE4, KOBE-424) closes; the conversation stays.
  { id: "area-close", name: "Close the panel", icon: XIcon, scope: "artifact" },
  // The artifact sheet (under 820 px) goes back to the conversation; its tabs stay open.
  { id: "artifact-back", name: "Back to the conversation", icon: ArrowLeftIcon, scope: "artifact" },
  // Hides the column (its tabs stay) or shows it again; opens the newest artifact when none is.
  {
    id: "toggle-artifacts",
    name: "Show or hide the artifact column",
    icon: PanelRightIcon,
    scope: "artifact",
    shortcut: "Mod+Shift+A",
    readOnlySafe: true,
  },
  // Keyboard and palette only (CE23, KOBE-225).
  {
    id: "command-palette",
    name: "Search actions, threads and files",
    icon: CommandIcon,
    scope: "app",
    shortcut: "Mod+K",
    readOnlySafe: true,
  },
  {
    id: "keyboard-shortcuts",
    name: "Keyboard shortcuts",
    icon: KeyboardIcon,
    scope: "app",
    shortcut: "?",
    readOnlySafe: true,
  },
  {
    id: "previous-thread",
    name: "Previous conversation",
    icon: ChevronsLeftIcon,
    scope: "app",
    shortcut: "Mod+[",
    readOnlySafe: true,
  },
  {
    id: "next-thread",
    name: "Next conversation",
    icon: ChevronsRightIcon,
    scope: "app",
    shortcut: "Mod+]",
    readOnlySafe: true,
  },
  {
    id: "focus-composer",
    name: "Go to the message box",
    icon: TextCursorInputIcon,
    scope: "app",
    shortcut: "Mod+/",
  },
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
