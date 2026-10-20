"use client";

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useContext } from "react";

/**
 * Navigation leaves the thread the way the bar's links do: client-side (the draft, its
 * attachments and a live run's stream stay in memory). Outside Next's app router (tests), a load.
 * Used by the `/` menu (KOBE-224), the palette (KOBE-225) and the pages in a panel over the
 * workspace (KOBE-452), whose addresses open the panel with the workspace still mounted.
 */
export function useNavigate(): (href: string) => void {
  const router = useContext(AppRouterContext);
  return (href) => {
    if (router) router.push(href);
    else window.location.assign(href);
  };
}
