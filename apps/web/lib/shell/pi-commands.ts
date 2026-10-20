/**
 * Pi's built-in commands and what Kobe does with each (KOBE-450). The sandbox pins Pi 1.0.0
 * (`images/sandbox/pi/package.json`); the list is its `BUILTIN_SLASH_COMMANDS`
 * (`dist/core/slash-commands.js`), plus `/llama`, which its docs list. Kobe runs Pi in RPC mode,
 * where these words are no commands at all, so none is ever passed to Pi: each is a Kobe command
 * (the same word, or Kobe's own word for it) or not offered, with the reason. The `/` menu shows
 * a not-offered word as one disabled row with its reason, so it is never sent as a message either.
 */
import type { CommandId } from "./commands";

export const PI_VERSION = "1.0.0";

export type PiMapping =
  /** Kobe has a command with this very word. */
  | { readonly kind: "same"; readonly command: CommandId }
  /** Kobe's command for it has another word; typing Pi's word offers Kobe's command. */
  | { readonly kind: "alias"; readonly command: CommandId }
  | { readonly kind: "not-offered"; readonly reason: string };

export interface PiCommand {
  readonly word: string;
  /** What it does in Pi (its own description). */
  readonly pi: string;
  readonly mapping: PiMapping;
}

const same = (command: CommandId): PiMapping => ({ kind: "same", command });
const alias = (command: CommandId): PiMapping => ({ kind: "alias", command });
const no = (reason: string): PiMapping => ({ kind: "not-offered", reason });

const NO_KEYS =
  "Pi's provider sign-in stores keys in the sandbox; Kobe keeps secrets out of it and reaches models through its own gateway.";

export const PI_BUILTIN_COMMANDS: readonly PiCommand[] = [
  {
    word: "settings",
    pi: "Open settings menu",
    mapping: no(
      "It edits Pi's own settings file in its terminal menu; your Kobe settings are in your profile and the consoles.",
    ),
  },
  { word: "model", pi: "Select model", mapping: same("choose-model") },
  {
    word: "tree",
    pi: "Navigate session tree (switch branches)",
    mapping: no(
      "It is Pi's terminal tree view; in Kobe each message shows its other versions, and Fork starts a new branch.",
    ),
  },
  { word: "thinking", pi: "Set thinking level", mapping: same("choose-thinking") },
  {
    word: "scoped-models",
    pi: "Enable/disable models for Ctrl+P cycling",
    mapping: no(
      "It configures model cycling in Pi's terminal; Kobe's models are your team's, chosen per conversation with /model.",
    ),
  },
  {
    word: "export",
    pi: "Export session (HTML or JSONL, to a path)",
    mapping: same("export-thread"),
  },
  {
    word: "import",
    pi: "Import and resume a session from a JSONL file",
    mapping: no(
      "It reads a session file from a path outside the workspace into Pi; Kobe keeps every conversation on its server.",
    ),
  },
  // Kobe shares within the team (never a public gist); Pi's upload is not offered.
  { word: "share", pi: "Share session as a secret GitHub gist", mapping: same("share-thread") },
  {
    word: "bug",
    pi: "Report a bug to the Pi developers",
    mapping: no(
      "It sends a report outside Kobe; rate the answer with thumbs down to tell the agent's owner.",
    ),
  },
  { word: "copy", pi: "Copy last agent message to clipboard", mapping: same("copy-thread") },
  { word: "name", pi: "Set session display name", mapping: alias("rename-thread") },
  { word: "session", pi: "Show session info and stats", mapping: same("thread-info") },
  {
    word: "changelog",
    pi: "Show changelog entries",
    mapping: no("It shows Pi's release notes, which are not Kobe's."),
  },
  { word: "hotkeys", pi: "Show all keyboard shortcuts", mapping: alias("keyboard-shortcuts") },
  {
    word: "fork",
    pi: "Create a new fork from a previous user message",
    mapping: same("fork-thread"),
  },
  // Kobe's /fork forks at the latest answer, which is Pi's /clone.
  {
    word: "clone",
    pi: "Duplicate the current session at the current position",
    mapping: alias("fork-thread"),
  },
  {
    word: "trust",
    pi: "Save project trust decision for future sessions",
    mapping: no(
      "It writes Pi's project trust file; in Kobe the server decides every tool call under your team's policy.",
    ),
  },
  { word: "login", pi: "Configure provider authentication", mapping: no(NO_KEYS) },
  { word: "logout", pi: "Remove provider authentication", mapping: no(NO_KEYS) },
  { word: "new", pi: "Start a new session", mapping: same("new-thread") },
  { word: "compact", pi: "Manually compact the session context", mapping: same("compact-thread") },
  { word: "resume", pi: "Resume a different session", mapping: alias("command-palette") },
  {
    word: "reload",
    pi: "Reload keybindings, extensions, skills, prompts, themes, and context files",
    mapping: no(
      "It reloads Pi's local extensions, skills and context files; Kobe's server sets each run's skills and tools.",
    ),
  },
  {
    word: "quit",
    pi: "Quit Pi",
    mapping: no("It ends the Pi process, which Kobe's server runs; use /stop to stop a run."),
  },
  {
    word: "llama",
    pi: "Manage models on the configured llama.cpp router",
    mapping: no(
      "It manages a llama.cpp router from Pi's own config; Kobe's models are set up in the Site console.",
    ),
  },
];

const BY_WORD: ReadonlyMap<string, PiCommand> = new Map(
  PI_BUILTIN_COMMANDS.map((c) => [c.word, c]),
);

/** Pi's built-in command with this word, if any (lowercase). */
export function piCommand(word: string): PiCommand | undefined {
  return BY_WORD.get(word);
}

/** Pi's words that offer `id` under another word (`/name` for Rename), for searching. */
export function piAliasesOf(id: CommandId): readonly string[] {
  return PI_BUILTIN_COMMANDS.flatMap((c) =>
    c.mapping.kind === "alias" && c.mapping.command === id ? [c.word] : [],
  );
}

/** The `/` menu's row for a word Kobe doesn't offer. */
export function notOfferedLabel(word: string, reason: string): string {
  return `/${word} isn't offered in Kobe: ${reason}`;
}
