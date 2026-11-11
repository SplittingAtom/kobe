/**
 * KOBE-616: ids for the guide's headings (h2–h4), so a page's sections have anchors
 * (`/docs/<slug>#<id>`). GitHub-style: lowercase, punctuation dropped, spaces to `-`, a repeat
 * gets `-1`, `-2`, ...
 */

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

const HEADINGS = new Set(["h2", "h3", "h4"]);

/** The rehype step: sets `id` on every h2–h4 without one. */
export function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const used = new Map<string, number>();
    const stack: HastNode[] = [tree];
    const ordered: HastNode[] = [];
    while (stack.length > 0) {
      const node = stack.shift() as HastNode;
      if (node.type === "element" && HEADINGS.has(node.tagName ?? "")) ordered.push(node);
      else if (node.children) stack.unshift(...node.children);
    }
    for (const heading of ordered) {
      const base = headingSlug(textOf(heading)) || "section";
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      heading.properties = { ...heading.properties, id: n === 0 ? base : `${base}-${n}` };
    }
  };
}
