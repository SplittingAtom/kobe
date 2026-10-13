"use client";

/**
 * Streaming arrival fade (CE11, KOBE-207). Words that arrive after the text mounted are each a
 * `<span data-kobe-word>`, keyed by their offset in the source, so a word keeps its element across
 * re-renders and re-parses and only new words mount; the CSS animation in `app/chat-global.css`
 * runs on mount, so just those fade. Text already there at mount (history, a thread opened or
 * reconnected mid-run) stays plain. No state beyond that mount-time length, no effects or timers:
 * the text renders exactly as often as it did before. The spans stay after the part finishes, so
 * the DOM (and any selection in it) is stable; `data-kobe-arrive` only switches the fade on.
 */
import { createContext, useContext, useState, type ReactNode } from "react";

const WORD = /\S+\s*/g;

/** A word with the whitespace after it, at `offset` in its text. */
export interface Word {
  readonly offset: number;
  readonly text: string;
}

/** `text` as its leading whitespace and its words. */
export function splitWords(text: string): {
  readonly lead: string;
  readonly words: readonly Word[];
} {
  const lead = text.match(/^\s*/)?.[0] ?? "";
  const words = [...text.matchAll(WORD)].map((m) => ({ offset: m.index, text: m[0] }));
  return { lead, words };
}

/** The source length when the text mounted: words before it were already on screen. */
export function useMountLength(text: string): number {
  const [length] = useState(text.length);
  return length;
}

/** `text` starting at source offset `start`: plain up to `settled`, then one span per word. */
function Words({
  text,
  start,
  settled,
}: {
  readonly text: string;
  readonly start: number;
  readonly settled: number;
}) {
  const { words } = splitWords(text);
  const first = words.findIndex((w) => start + w.offset >= settled);
  if (first === -1) return text;
  const fresh = words.slice(first);
  return (
    <>
      {text.slice(0, fresh[0]?.offset)}
      {fresh.map((w) => (
        <span key={start + w.offset} data-kobe-word="">
          {w.text}
        </span>
      ))}
    </>
  );
}

/** Plain text (reasoning) with its arriving words as spans. */
export function ArrivingWords({ text }: { readonly text: string }) {
  return <Words text={text} start={0} settled={useMountLength(text)} />;
}

/** Markdown's mount-time source length, for the word groups below it. */
export const SettledContext = createContext(Number.POSITIVE_INFINITY);

/** A text run the rehype step marked (`data-kobe-words` = its source offset), as words. */
export function MarkdownWords({ text, start }: { readonly text: string; readonly start: number }) {
  return <Words text={text} start={start} settled={useContext(SettledContext)} />;
}

export function SettledProvider({
  text,
  children,
}: {
  readonly text: string;
  readonly children: ReactNode;
}) {
  return <SettledContext.Provider value={useMountLength(text)}>{children}</SettledContext.Provider>;
}

interface HastNode {
  readonly type: string;
  readonly value?: string;
  readonly tagName?: string;
  readonly position?: { readonly start?: { readonly offset?: number } };
  readonly children?: readonly HastNode[];
}

/** Code renders plain: fades are for prose, and code blocks can be long. */
const PLAIN = new Set(["pre", "code"]);

function wordRun(text: HastNode): HastNode {
  const start = text.position?.start?.offset;
  if (typeof start !== "number" || !/\S/.test(text.value ?? "")) return text;
  return {
    type: "element",
    tagName: "span",
    properties: { dataKobeWords: start },
    children: [text],
  } as HastNode;
}

/**
 * rehype step for Markdown: each text run with a word in it becomes a marked span, which
 * `markdown.tsx` renders as `MarkdownWords` (no element of its own). Whitespace-only runs (between
 * list items, table rows), runs without a source position and code stay as they are.
 */
export function rehypeArrivingWords() {
  const visit = (node: HastNode): HastNode => {
    if (!node.children || PLAIN.has(node.tagName ?? "")) return node;
    const children = node.children.map((child) =>
      child.type === "text" ? wordRun(child) : visit(child),
    );
    return { ...node, children };
  };
  return (tree: HastNode): HastNode => visit(tree);
}
