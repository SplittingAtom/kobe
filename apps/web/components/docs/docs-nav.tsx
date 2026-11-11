"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { cn } from "../../lib/utils";

export interface DocsNavPage {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
}

export interface DocsNavGroup {
  readonly section: string;
  readonly id: string;
  readonly pages: readonly DocsNavPage[];
}

/** Pages whose title or summary holds every word of the query (case-insensitive). */
export function filterPages(groups: readonly DocsNavGroup[], query: string): DocsNavPage[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const all = groups.flatMap((g) => g.pages);
  if (words.length === 0) return all;
  return all.filter((p) => {
    const text = `${p.title} ${p.summary}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

function PageLink({ page, current }: { readonly page: DocsNavPage; readonly current: boolean }) {
  return (
    <Link
      href={`/docs/${page.slug}`}
      aria-current={current ? "page" : undefined}
      className={cn(
        "block rounded-md px-2 py-1 text-sm no-underline",
        current
          ? "bg-accent text-accent-foreground font-medium"
          : "text-foreground hover:bg-accent/60",
      )}
    >
      {page.title}
    </Link>
  );
}

/**
 * The guide's left nav (KOBE-616): pages by section, a filter over titles and summaries. Under
 * 768 px it folds behind a Contents button so the page comes first.
 */
export function DocsNav({
  groups,
  current,
}: {
  readonly groups: readonly DocsNavGroup[];
  readonly current: string | null;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const navId = useId();
  const matches = useMemo(() => filterPages(groups, query), [groups, query]);
  const filtering = query.trim() !== "";
  return (
    <div className="md:w-64 md:shrink-0">
      <button
        type="button"
        className="border-border mb-3 w-full rounded-md border px-3 py-2 text-start text-sm md:hidden"
        aria-expanded={open}
        aria-controls={navId}
        onClick={() => setOpen(!open)}
      >
        Contents
      </button>
      <nav
        id={navId}
        aria-label="Guide"
        className={cn("md:sticky md:top-4 md:block", open ? "block" : "hidden")}
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter pages"
          aria-label="Filter pages"
          className="border-border bg-background text-foreground mb-3 w-full rounded-md border px-3 py-1.5 text-sm"
        />
        {filtering ? (
          matches.length === 0 ? (
            <p className="text-muted-foreground px-2 text-sm">No pages match.</p>
          ) : (
            <ul className="m-0 list-none p-0">
              {matches.map((p) => (
                <li key={p.slug}>
                  <PageLink page={p} current={p.slug === current} />
                </li>
              ))}
            </ul>
          )
        ) : (
          groups.map((g) => (
            <section key={g.id} aria-labelledby={`${navId}-${g.id}`} className="mb-4">
              <h2
                id={`${navId}-${g.id}`}
                className="text-muted-foreground m-0 mb-1 px-2 text-xs font-semibold tracking-wide uppercase"
              >
                {g.section}
              </h2>
              <ul className="m-0 list-none p-0">
                {g.pages.map((p) => (
                  <li key={p.slug}>
                    <PageLink page={p} current={p.slug === current} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>
    </div>
  );
}
