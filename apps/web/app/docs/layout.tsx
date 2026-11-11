import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { IconActionProvider } from "../../components/shell/icon-action";
import { getSiteBranding } from "../../lib/theme/branding-server";
import "./docs-global.css";

export const metadata: Metadata = { title: "Docs" };

/**
 * The Kobe guide (KOBE-616), opened from the bar's Docs icon. A page of its own, outside the
 * workspace (like sign-in), and readable without a session: the guide is built into the bundle and
 * holds no team or user data. Agents read the same pages at /llms.txt.
 */
export default async function DocsLayout({ children }: { readonly children: ReactNode }) {
  const { appName } = await getSiteBranding();
  return (
    <IconActionProvider>
      <div data-kobe-docs="" className="bg-background text-foreground min-h-dvh">
        <header className="border-border flex items-center gap-4 border-b px-4 py-3">
          <Link href="/docs" className="text-foreground font-semibold no-underline">
            {appName} Docs
          </Link>
          <Link href="/" className="ms-auto text-sm">
            Back to {appName}
          </Link>
        </header>
        <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
      </div>
    </IconActionProvider>
  );
}
