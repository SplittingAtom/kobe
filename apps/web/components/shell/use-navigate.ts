"use client";

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { useContext } from "react";

/**
 * Navigation leaves the thread the way the bar's links do: client-side (the draft, its
 * attachments and a live run's stream stay in memory). Outside Next's app router (tests), a load.
 * Used by the `/` menu (KOBE-224) and the palette (KOBE-225).
 */
export function useNavigate(): (href: string) => void {
  const router = useContext(AppRouterContext);
  return (href) => (router ? router.push(href) : window.location.assign(href));
}
