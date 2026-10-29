import { describe, expect, it } from "vitest";
import { COMMANDS, command } from "./commands";
import type { MenuBindings } from "./menu";
import { filterActions, paletteActions } from "./palette";
import { PI_BUILTIN_COMMANDS, PI_VERSION, piCommand, refusedPiCommand } from "./pi-commands";
import { NOT_HERE, SLASH_NO_MATCH, slashEntries, slashItems, slashOutcome } from "./slash";

/**
 * KOBE-450: Pi's built-in commands (the sandbox pins Pi 1.0.0; `BUILTIN_SLASH_COMMANDS` in its
 * `dist/core/slash-commands.js`, plus `/llama`, which its docs list) each map to a Kobe command
 * or are not offered, with the reason. Nothing typed is ever run by Pi as a command.
 */
const PI_BUILTINS = [
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
];

const slashWords = COMMANDS.flatMap((c) => (c.slash === undefined ? [] : [c.slash]));
const run = () => {};
const bindings: MenuBindings = {
  "rename-thread": { onSelect: run },
  "fork-thread": { onSelect: run },
  "command-palette": { onSelect: run },
  "keyboard-shortcuts": { onSelect: run },
  "thread-info": { onSelect: run },
  "export-thread": { onSelect: run },
};
const entries = slashEntries(bindings, { readOnly: false });
const items = (name: string, arg?: string) => slashItems({ offset: 0, name, arg }, entries);

describe("the Pi command mapping (ac-2, ac-6)", () => {
  it("covers every built-in command of the pinned Pi, and /llama from its docs", () => {
    expect(PI_VERSION).toBe("1.4.0");
    expect(PI_BUILTIN_COMMANDS.map((c) => c.word).sort()).toEqual([...PI_BUILTINS, "llama"].sort());
  });

  it("a mapped word names a Kobe command with a / word: the same word, or Kobe's own", () => {
    for (const pi of PI_BUILTIN_COMMANDS) {
      const m = pi.mapping;
      if (m.kind === "not-offered") continue;
      const target = command(m.command);
      expect(target.slash, pi.word).toBeDefined();
      if (m.kind === "same") expect(target.slash).toBe(pi.word);
      // An alias never takes a word another command has: one command per word.
      else expect(slashWords).not.toContain(pi.word);
    }
  });

  it("config, login, keys, files outside the workspace and the TUI are not offered, with reasons", () => {
    const refused = PI_BUILTIN_COMMANDS.filter((c) => c.mapping.kind === "not-offered");
    expect(refused.map((c) => c.word).sort()).toEqual(
      [
        "bug",
        "changelog",
        "import",
        "llama",
        "login",
        "logout",
        "quit",
        "reload",
        "scoped-models",
        "settings",
        "tree",
        "trust",
      ].sort(),
    );
    for (const c of refused) {
      expect(c.mapping.kind === "not-offered" && c.mapping.reason.length).toBeGreaterThan(20);
      expect(slashWords).not.toContain(c.word);
    }
  });

  it("the new Kobe commands for Pi's words: /thinking, /session, /export", () => {
    for (const word of ["thinking", "session", "export"]) {
      expect(piCommand(word)?.mapping.kind).toBe("same");
      expect(slashWords).toContain(word);
    }
  });
});

describe("the / menu knows Pi's words (ac-3, ac-6)", () => {
  it("a Pi word Kobe names differently offers Kobe's command", () => {
    expect(items("name").map((i) => i.label)).toEqual(["/rename"]);
    expect(items("clone").map((i) => i.label)).toEqual(["/fork"]);
    expect(items("hotkeys").map((i) => i.label)).toEqual(["/shortcuts"]);
    expect(items("resume").map((i) => i.label)).toEqual(["/search"]);
    const pick = must(items("name")[0]);
    expect(slashOutcome(pick, entries)).toEqual({ kind: "run", run });
  });

  it("a Pi word Kobe doesn't offer keeps one disabled row with the reason; nothing is sent", () => {
    for (const word of ["login", "settings", "trust", "reload", "quit", "import"]) {
      const rows = items(word);
      expect(rows).toHaveLength(1);
      const row = must(rows[0]);
      expect(row.type).toBe(SLASH_NO_MATCH);
      expect(row.label).toMatch(new RegExp(`^/${word} isn't offered in Kobe: `));
      expect(slashOutcome(row, entries)).toEqual({ kind: "blocked", reason: row.label });
      // With an argument too (`/login anthropic`).
      expect(items(word, "anthropic").map((i) => i.type)).toEqual([SLASH_NO_MATCH]);
    }
  });

  it("where Kobe's command isn't bound, the Pi word still shows it, blocked (review LOW-6)", () => {
    const unbound = slashEntries({}, { readOnly: false });
    const rows = slashItems({ offset: 0, name: "name", arg: undefined }, unbound);
    expect(rows.map((r) => [r.label, r.metadata?.["blocker"]])).toEqual([["/rename", NOT_HERE]]);
    expect(slashOutcome(must(rows[0]), unbound).kind).toBe("blocked");
  });

  it("a prefix still lists Kobe's own commands only", () => {
    expect(items("log").map((i) => i.label)).toEqual([]);
    expect(items("se").map((i) => i.label)).toEqual(["/session", "/search"]);
  });
});

describe("the palette finds a command by its Pi word too", () => {
  it("rename by name, fork by clone", () => {
    const actions = paletteActions(bindings, { readOnly: false });
    expect(filterActions(actions, "name").map((a) => a.command.id)).toContain("rename-thread");
    expect(filterActions(actions, "clone").map((a) => a.command.id)).toContain("fork-thread");
  });
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("missing");
  return v;
}

describe("refusedPiCommand: a message starting with a not-offered Pi word (review LOW-5)", () => {
  it("refuses /login and /login with text, with the reason and the way to send it anyway", () => {
    expect(refusedPiCommand("/login")).toMatch(
      /^\/login isn't offered in Kobe: .*Start with a space/,
    );
    expect(refusedPiCommand("/LOGIN anthropic")).toMatch(/^\/login isn't offered/);
    expect(refusedPiCommand("/trust\nplease")).toMatch(/^\/trust isn't offered/);
  });

  it("lets through a leading space, Kobe's words, mapped Pi words, unknown words and paths", () => {
    for (const text of [
      " /login",
      "/loginx",
      "/model",
      "/name x",
      "/hello",
      "/usr/bin/login",
      "hi /login",
      "",
    ]) {
      expect(refusedPiCommand(text), text).toBeNull();
    }
  });
});
