"use client";

import { usePathname, useRouter } from "next/navigation";
import { useMemo, type ReactNode } from "react";
import "../../app/chat-global.css";
import { isWorkspacePath } from "../../lib/shell/panels";
import { ChatApp, type WorkspaceRoute } from "../chat/chat-app";

/**
 * The workspace in the root layout (KOBE-452): on the chat and on every page that opens as a panel
 * over it (the consoles, My agents, Skills, the My area; `lib/shell/panels.ts`), the chat stays
 * mounted while the address changes, so a run keeps streaming and the draft, scroll and thread
 * stay as they were; the route's page renders in the panel. Every other page (sign-in, setup,
 * invitations) is rendered on its own.
 */
export function WorkspaceHost({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const route = useMemo<WorkspaceRoute>(
    () => ({
      pathname,
      page: children,
      push: (href) => router.push(href),
      replace: (href) => router.replace(href),
    }),
    [pathname, children, router],
  );
  if (!isWorkspacePath(pathname)) return children;
  return <ChatApp route={route} />;
}
