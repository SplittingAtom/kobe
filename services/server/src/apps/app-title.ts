import type { PinnedTool } from "@kobe/db";
import { fallbackTitle } from "../threads/title.js";

/**
 * An MCP App's title (KOBE-447), plain text everywhere it shows (the rail, the frame's title,
 * the chips, a launched thread's title): the opening tool's `title`, else its annotations' title,
 * else the pinned template's `<title>`, else the tool's name made readable. Each candidate goes
 * through the thread title rules (control, format and separator characters removed, at most
 * 120 characters); an empty result falls to the next.
 */

/** How far into the template a `<title>` is looked for: it belongs in the head. */
export const HEAD_SCAN_CHARS = 64 * 1024;

const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function codePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff)
    ? String.fromCodePoint(n)
    : "";
}

/** The character references a title may carry; anything else stays as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/giu, (all, ref: string) => {
    if (ref[0] !== "#") return NAMED[ref.toLowerCase()] ?? all;
    const hex = ref[1] === "x" || ref[1] === "X";
    return codePoint(Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

/** Where the head ends: `</head>` or `<body`, whichever comes first (else the scanned text). */
function headEnd(lower: string): number {
  const ends = [lower.indexOf("</head"), lower.indexOf("<body")].filter((i) => i >= 0);
  return ends.length === 0 ? lower.length : Math.min(...ends);
}

/**
 * The template's `<title>` as plain text, or undefined. A string scan, never a regular expression
 * over the bytes, so hostile markup costs linear time; only the head is read, so an SVG's
 * `<title>` in the body is not the page's.
 */
export function templateTitle(html: string): string | undefined {
  const lower = html.slice(0, HEAD_SCAN_CHARS).toLowerCase();
  const end = headEnd(lower);
  for (
    let at = lower.indexOf("<title");
    at >= 0 && at < end;
    at = lower.indexOf("<title", at + 1)
  ) {
    const next = lower[at + 6];
    if (next !== ">" && next !== "/" && !/\s/u.test(next ?? "")) continue;
    const open = lower.indexOf(">", at);
    const close = open < 0 ? -1 : lower.indexOf("</title", open);
    if (close < 0 || close > end) return undefined;
    const text = decodeEntities(html.slice(open + 1, close)).replace(/\s+/gu, " ");
    return fallbackTitle(text);
  }
  return undefined;
}

/** `open_lakehouse_explorer` or `openLakehouseExplorer` → "Open lakehouse explorer". */
export function humaniseToolName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[\s_\-.]+/u)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return name;
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The app's title from its opening tool and its pinned template's `<title>`, if any. */
export function appTitle(tool: PinnedTool, fromTemplate: string | undefined): string {
  const candidates = [
    tool.title,
    tool.annotations.title,
    fromTemplate,
    humaniseToolName(tool.name),
    tool.name,
  ];
  for (const c of candidates) {
    const title = typeof c === "string" ? fallbackTitle(c) : undefined;
    if (title !== undefined) return title;
  }
  return "App";
}
