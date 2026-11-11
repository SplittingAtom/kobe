import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getSiteBranding } from "../../lib/theme/branding-server";
import "./docs-global.css";

export const metadata: Metadata = { title: "Docs" };

/**
 * The Kobe guide (KOBE-616), opened from the bar's Docs icon as a panel over the workspace, the
 * way the Site console opens (KOBE-452, `lib/shell/panels.ts`): the conversation stays mounted
 * underneath, the panel's Close, Escape and a press outside close it, and its address
 * (`/docs/<slug>`) is a link, a reload and Back like any panel's. The panel frame carries the
 * heading and Close; this is its content. Readable without a session: the guide is built into the
 * bundle and holds no team or user data. Agents read the same pages at /llms.txt.
 */
export default async function DocsLayout({ children }: { readonly children: ReactNode }) {
  const { appName } = await getSiteBranding();
  return (
    <div data-kobe-docs="" className="text-foreground mx-auto max-w-6xl px-4 py-6">
      <p className="mt-0 mb-4 text-sm">
        <Link href="/docs">{appName} guide home</Link>
      </p>
      {children}
    </div>
  );
}
