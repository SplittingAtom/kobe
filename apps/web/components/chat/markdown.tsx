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
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button";

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
    <div className="border-border bg-muted/40 my-3 overflow-hidden rounded-lg border">
      <div className="bg-muted/60 text-muted-foreground flex items-center justify-end px-2 py-1">
        <TooltipIconButton
          tooltip={copied ? "Copied" : "Copy code"}
          type="button"
          onClick={() => void copy()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </TooltipIconButton>
      </div>
      <pre className="max-h-96 overflow-auto p-3 font-mono text-sm leading-normal whitespace-pre">
        {children}
      </pre>
    </div>
  );
}

const LINK =
  "text-primary decoration-primary/40 hover:decoration-primary underline underline-offset-4";

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const url = safeUrl(href);
    if (!url) return <span>{children}</span>;
    return (
      <a className={LINK} href={url} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => {
    const url = safeUrl(typeof src === "string" ? src : undefined);
    const label = alt?.trim() ? `Image: ${alt.trim()}` : "Image";
    if (!url) return <span>[{label}]</span>;
    return (
      <a className={LINK} href={url} target="_blank" rel="noopener noreferrer nofollow">
        [{label}]
      </a>
    );
  },
  pre: ({ children, node }) => (
    <CodeBlock code={textOf(node as HastNode | undefined)}>{children}</CodeBlock>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="bg-muted border-border border-s border-t px-3 py-1.5 text-start font-medium first:rounded-tl-lg first:border-s last:rounded-tr-lg last:border-e [&:not(:first-child)]:border-s-0">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-border border-s border-b px-3 py-1.5 text-start last:border-e [&:not(:first-child)]:border-s-0">
      {children}
    </td>
  ),
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-2xl font-semibold tracking-tight">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-xl font-semibold tracking-tight">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mt-3 mb-2 text-lg font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 mb-1 text-base font-semibold">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-3 mb-1 text-base font-medium">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-3 mb-1 text-base font-medium">{children}</h6>,
  p: ({ children }) => <p className="my-3 leading-7">{children}</p>,
  ul: ({ children, className }) => (
    <ul
      className={cn(
        "my-3 ms-5 list-disc [&>li]:mt-1",
        className?.includes("contains-task-list") && "list-none ms-1",
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => <ol className="my-3 ms-5 list-decimal [&>li]:mt-1">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="border-border text-muted-foreground my-3 border-s-2 ps-4 italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border my-4" />,
};

const REMARK_PLUGINS = [remarkGfm, remarkHtmlAsText];

/** Unsafe URLs are dropped before rendering; the components above check again. */
function urlTransform(url: string): string {
  return safeUrl(url) ?? "";
}

export function Markdown({ text }: { readonly text: string }) {
  return (
    <div className="[&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:rounded-md [&_:not(pre)>code]:border [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&>:first-child]:mt-0 [&>:last-child]:mb-0">
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
