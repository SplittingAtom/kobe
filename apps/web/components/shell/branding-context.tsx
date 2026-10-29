"use client";

import type { SiteBranding } from "@kobe/protocol";
import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_BRANDING } from "../../lib/theme/branding-defaults";

/**
 * The site branding for client components (theming plan TH5): the root layout fetches it on the
 * server (lib/theme/branding-server.ts) and provides it here, so the name and logo are in the
 * first HTML. Without a provider (tests, isolated renders) it is the Kobe defaults.
 */
const BrandingContext = createContext<SiteBranding>(DEFAULT_BRANDING);

export function BrandingProvider({
  value,
  children,
}: {
  readonly value: SiteBranding;
  readonly children: ReactNode;
}) {
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): SiteBranding {
  return useContext(BrandingContext);
}

/** The app name as text, for server components' copy ("Back to Kobe"). */
export function AppName(): string {
  return useBranding().appName;
}
