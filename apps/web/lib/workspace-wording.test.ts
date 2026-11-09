import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Workspaces product strings (WS5; KOBE-581 ac-3): the team role is "Contributor" (no "Builder"
 * anywhere a person reads it), and the shell never calls the member's own files (the
 * scratchspace, "My files") "your workspace": Workspace is the place a team works in.
 */
const ROOT = new URL("../", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !path.includes("/testing")
      ? [path]
      : [];
  });
}

/** Lines that hold text a person reads: string literals and JSX text, comments dropped. */
function textLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .map((line) => line.replace(/\/\/.*$/, ""));
}

const SHOWN = (word: string) =>
  new RegExp(`(["'\`>]|^\\s+)[^"'\`<>{}]*\\b${word}\\b[^"'\`<>{}]*(["'\`<]|$)`, "i");

describe("Workspaces wording (WS5, ac-3)", () => {
  it('no string says "Builder" for the team role', () => {
    const hits = ["app", "components", "lib"]
      .flatMap((d) => sources(join(ROOT, d)))
      .flatMap((path) =>
        textLines(path)
          .filter((line) => /\bBuilders?\b/.test(line) && SHOWN("Builders?").test(line))
          // Code names (BuilderTab, <Builder …/>), not words.
          .filter((line) => !/<\/?Builder\b|function Builder\b/.test(line))
          .map((line) => `${path.slice(ROOT.length)}: ${line.trim()}`),
      );
    expect(hits).toEqual([]);
  });

  it('the shell never calls the member\'s files "your workspace" or "my workspace"', () => {
    const hits = [
      "components/shell",
      "components/files",
      "components/chat",
      "lib/chat",
      "lib/files",
    ]
      .flatMap((d) => sources(join(ROOT, d)))
      .flatMap((path) =>
        textLines(path)
          .filter((line) => /\b(your|my) workspace\b/i.test(line))
          .map((line) => `${path.slice(ROOT.length)}: ${line.trim()}`),
      );
    expect(hits).toEqual([]);
  });
});
