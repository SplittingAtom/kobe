"use client";

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useContext } from "react";
import { openBeside } from "../../lib/shell/areas";

/**
 * Navigation leaves the thread the way the bar's links do: client-side (the draft, its
 * attachments and a live run's stream stay in memory). Outside Next's app router (tests), a load.
 * Used by the `/` menu (KOBE-224) and the palette (KOBE-225). On the chat page, My memory, My
 * approvals, My schedules and My connectors open beside the thread instead (CE4).
 */
export function useNavigate(): (href: string) => void {
  const router = useContext(AppRouterContext);
  return (href) => {
    // The My area pages CE4 puts beside the thread open there from the chat (KOBE-424).
    if (openBeside(href)) return;
    if (router) router.push(href);
    else window.location.assign(href);
  };
}
