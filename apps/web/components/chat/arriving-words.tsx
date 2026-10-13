/**
 * Streaming arrival fade (CE11, KOBE-207). While a part streams, each word is its own
 * `<span data-kobe-word>`; React keeps the spans already on screen and mounts one per new word, so
 * the CSS animation in `app/chat-global.css` (which runs when an element first matches) fades just
 * the words that arrived. No state, effects or timers: the text renders exactly as often as it
 * did before. A finished part renders as plain text again, so history carries no extra elements.
 */

/** A word with the whitespace after it; whitespace before the first word stays plain text. */
const WORD = /\S+\s*/g;

/** `text` as [leading whitespace, ...words], each word with its trailing whitespace. */
export function splitWords(text: string): { readonly lead: string; readonly words: string[] } {
  const words = text.match(WORD) ?? [];
  const lead = words.length === 0 ? text : text.slice(0, text.indexOf(words[0] as string));
  return { lead, words };
}

/** Plain text (reasoning) as word spans. Keys are positions: arrived words never remount. */
export function ArrivingWords({ text }: { readonly text: string }) {
  const { lead, words } = splitWords(text);
  return (
    <>
      {lead}
      {words.map((word, i) => (
        <span key={i} data-kobe-word="">
          {word}
        </span>
      ))}
    </>
  );
}

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function wordNodes(text: string): HastNode[] {
  const { lead, words } = splitWords(text);
  const spans = words.map((word): HastNode => ({
    type: "element",
    tagName: "span",
    properties: { dataKobeWord: "" },
    children: [{ type: "text", value: word }],
  }));
  return lead === "" ? spans : [{ type: "text", value: lead }, ...spans];
}

/**
 * rehype step for Markdown: every text node with a word in it becomes word spans. Whitespace-only
 * text (between list items, table rows) stays as it is. react-markdown keys siblings by tag and
 * position (`span-0`, `span-1`, ...), so appended words are new elements and earlier ones stay.
 */
export function rehypeArrivingWords() {
  const visit = (node: HastNode): HastNode => {
    if (!node.children) return node;
    const children = node.children.flatMap((child) =>
      child.type === "text" && /\S/.test(child.value ?? "")
        ? wordNodes(child.value ?? "")
        : [visit(child)],
    );
    return { ...node, children };
  };
  return (tree: HastNode): HastNode => visit(tree);
}
