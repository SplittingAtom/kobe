"use client";

/**
 * Agent text as Markdown (GFM: tables, task lists, strikethrough, fenced code), rendered safely:
 *
 * - **No raw HTML.** HTML in the text is shown as text (a remark step turns `html` nodes into text
 *   nodes); there is no `rehype-raw`, so nothing the agent writes becomes markup.
 * - **Links:** only absolute `http:`, `https:` and `mailto:` URLs become links, opened in a new tab
 *   with `rel="noopener noreferrer nofollow"`. Anything else (`javascript:`, `data:`, relative,
 *   malformed) is rendered as its text.
 * - **No images are loaded** (no tracking pixels, no requests to arbitrary hosts; the CSP's
 *   `img-src` stays `'self' data:`): a Markdown image becomes a link to it, or its alt text when its
 *   URL isn't safe.
 * - Code blocks have a Copy button.
 */
import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./chat.module.css";

const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/** The URL when it is an absolute http(s)/mailto URL, else undefined. */
export function safeUrl(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    const url = new URL(trimmed);
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined; // relative or malformed: no base to resolve against, shown as text
  }
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** remark step: raw HTML (`html` nodes) becomes plain text, so it is shown and never parsed. */
function remarkHtmlAsText() {
  return (tree: MdNode) => {
    const stack: MdNode[] = [tree];
    while (stack.length > 0) {
      const node = stack.pop() as MdNode;
      if (node.type === "html") node.type = "text";
      if (node.children) stack.push(...node.children);
    }
  };
}

interface HastNode {
  type: string;
  value?: string;
  children?: HastNode[];
}

function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function CodeBlock({ children, code }: { readonly children: ReactNode; readonly code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false); // clipboard blocked (insecure origin or permission): nothing to undo
    }
  };
  return (
    <div className={styles.codeBlock}>
      <button type="button" className={styles.copyCode} onClick={() => void copy()}>
        {copied ? "Copied" : "Copy code"}
      </button>
      <pre className={styles.toolPre}>{children}</pre>
    </div>
  );
}

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const url = safeUrl(href);
    if (!url) return <span>{children}</span>;
    return (
      <a href={url} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => {
    const url = safeUrl(typeof src === "string" ? src : undefined);
    const label = alt?.trim() ? `Image: ${alt.trim()}` : "Image";
    if (!url) return <span>[{label}]</span>;
    return (
      <a href={url} target="_blank" rel="noopener noreferrer nofollow">
        [{label}]
      </a>
    );
  },
  pre: ({ children, node }) => (
    <CodeBlock code={textOf(node as HastNode | undefined)}>{children}</CodeBlock>
  ),
  table: ({ children }) => (
    <div className={styles.tableWrap}>
      <table>{children}</table>
    </div>
  ),
};

const REMARK_PLUGINS = [remarkGfm, remarkHtmlAsText];

/** Unsafe URLs are dropped before rendering; the components above check again. */
function urlTransform(url: string): string {
  return safeUrl(url) ?? "";
}

export function Markdown({ text }: { readonly text: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={COMPONENTS}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
