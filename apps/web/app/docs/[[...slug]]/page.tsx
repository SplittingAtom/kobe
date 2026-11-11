import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "../../../components/chat/markdown";
import { CopyUrl } from "../../../components/docs/copy-url";
import { DocsNav, type DocsNavGroup } from "../../../components/docs/docs-nav";
import { groupBySection, pageBySlug, prevNext } from "../../../lib/docs/guide";
import type { GuidePage } from "../../../lib/docs/guide-loader";
import { getSiteBranding } from "../../../lib/theme/branding-server";

type Props = { readonly params: Promise<{ slug?: string[] }> };

function slugOf(parts: readonly string[] | undefined): string | null {
  return parts && parts.length > 0 ? parts.map((s) => decodeURIComponent(s)).join("/") : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = slugOf((await params).slug);
  const page = slug === null ? null : pageBySlug(slug);
  return page === null ? { title: "Docs" } : { title: page.title, description: page.summary };
}

/** Only what the nav needs goes to the client: no page bodies. */
function navGroups(): DocsNavGroup[] {
  return groupBySection().map((g) => ({
    section: g.section,
    id: g.id,
    pages: g.pages.map(({ slug, title, summary }) => ({ slug, title, summary })),
  }));
}

function Home({ appName }: { readonly appName: string }) {
  return (
    <article className="min-w-0 flex-1">
      <h1 className="mt-0 mb-2 text-2xl font-semibold tracking-tight">{appName} guide</h1>
      <p className="text-muted-foreground mt-0 mb-6">
        How to use {appName}: conversations, files, agents, skills and the admin consoles.
      </p>
      <section
        aria-labelledby="for-agents"
        className="border-border bg-muted/40 mb-8 rounded-lg border p-4"
      >
        <h2 id="for-agents" className="mt-0 mb-2 text-base font-semibold">
          For agents
        </h2>
        <p className="mt-0 mb-2 text-sm">
          The same guide as plain Markdown, in the llms.txt format agents read:
        </p>
        <ul className="m-0 list-none space-y-2 p-0 text-sm">
          <li>
            Index: <CopyUrl path="/llms.txt" />
          </li>
          <li>
            Every page in one file: <CopyUrl path="/llms-full.txt" />
          </li>
        </ul>
      </section>
      {groupBySection().map((g) => (
        <section key={g.id} id={g.id} aria-labelledby={`${g.id}-heading`} className="mb-6">
          <h2 id={`${g.id}-heading`} className="mt-0 mb-2 text-lg font-semibold">
            {g.section}
          </h2>
          <ul className="m-0 list-none space-y-2 p-0">
            {g.pages.map((p) => (
              <li key={p.slug}>
                <Link href={`/docs/${p.slug}`} className="font-medium">
                  {p.title}
                </Link>
                <span className="text-muted-foreground block text-sm">{p.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}

function PageView({ page }: { readonly page: GuidePage }) {
  const { prev, next } = prevNext(page.slug);
  return (
    <article className="min-w-0 flex-1">
      <p className="text-muted-foreground mt-0 mb-1 text-sm">{page.section}</p>
      <h1 className="mt-0 mb-2 text-2xl font-semibold tracking-tight">{page.title}</h1>
      <p className="text-muted-foreground mt-0 mb-4">{page.summary}</p>
      <p className="mt-0 mb-6 text-sm">
        <a href={`/docs/${page.slug}.md`}>View as Markdown</a>
      </p>
      <div data-kobe-guide-body="">
        <Markdown text={page.body} variant="guide" />
      </div>
      <nav
        aria-label="Previous and next page"
        className="border-border mt-10 flex flex-wrap justify-between gap-4 border-t pt-4 text-sm"
      >
        {prev ? (
          <Link href={`/docs/${prev.slug}`} rel="prev">
            ← {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link href={`/docs/${next.slug}`} rel="next" className="ms-auto">
            {next.title} →
          </Link>
        )}
      </nav>
    </article>
  );
}

/** /docs (sections and pages) and /docs/<slug> (one page), from the guide in the bundle. */
export default async function DocsPage({ params }: Props) {
  const slug = slugOf((await params).slug);
  const page = slug === null ? null : pageBySlug(slug);
  if (slug !== null && page === null) notFound();
  const { appName } = await getSiteBranding();
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      <DocsNav groups={navGroups()} current={page?.slug ?? null} />
      {page === null ? <Home appName={appName} /> : <PageView page={page} />}
    </div>
  );
}
