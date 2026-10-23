import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { StyleNonce } from "../components/security/style-nonce";
import { NewBuildBanner } from "../components/shell/new-build-banner";
import { WorkspaceHost } from "../components/shell/workspace-host";
import { CLIENT_BUILD_ID } from "../lib/build/build-id";
import { themeFromCookies } from "../lib/theme/theme";
import "./theme.css";

export const metadata: Metadata = {
  title: "Kobe",
  description: "Self-hosted conversational agent platform",
  // KOBE-487: the build this page came from (the client compares it with /api/build).
  other: { "kobe-build": CLIENT_BUILD_ID },
};

/** The on-screen keyboard shrinks the layout, so the chat's composer stays above it (KOBE-205). */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

/**
 * Rendered per request: the CSP nonce (`proxy.ts`) only exists at request time, and Next puts it
 * on its scripts while rendering. Pages hold no user data on the server either way. The saved
 * theme (KOBE-282) is read here so the first paint is already in it; without one, app/theme.css
 * follows the OS. The workspace (the chat and the panels over it, KOBE-452) lives here, so it stays
 * mounted while a console or a My area page opens over it. StyleNonce gives Radix's injected
 * scroll-lock style the nonce (KOBE-469). The new-build banner (KOBE-487) offers a reload on every
 * page once the web was redeployed under it.
 */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  await connection();
  const theme = themeFromCookies(await cookies());
  return (
    <html lang="en" data-theme={theme ?? undefined}>
      <body>
        <StyleNonce />
        <WorkspaceHost>{children}</WorkspaceHost>
        <NewBuildBanner />
      </body>
    </html>
  );
}
