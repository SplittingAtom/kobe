import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { StyleNonce } from "../components/security/style-nonce";
import { BrandingProvider } from "../components/shell/branding-context";
import { NewBuildBanner } from "../components/shell/new-build-banner";
import { WorkspaceHost } from "../components/shell/workspace-host";
import { brandingCss } from "../lib/theme/branding-css";
import { getSiteBranding } from "../lib/theme/branding-server";
import { themeFromCookies } from "../lib/theme/theme";
import "./theme.css";

/**
 * Titles and icons from the site branding (theming plan TH5): `<page> · <name>` (pages set plain
 * titles, "Site console"), the name alone where a page sets none. The favicon is the configured
 * one, else the shipped app/icon.svg (Next adds a file icon only when `icons` is not set here).
 */
export async function generateMetadata(): Promise<Metadata> {
  const { appName, favicon } = await getSiteBranding();
  return {
    title: { default: appName, template: `%s · ${appName}` },
    description: "Self-hosted conversational agent platform",
    ...(favicon === null ? {} : { icons: { icon: favicon } }),
  };
}

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
 *
 * The site branding (TH5, KOBE-500) is fetched here (cached 30 s, defaults when the server is
 * unreachable): its theme is one nonced `<style>` of token declarations in <head>, rendered only
 * when there is something to override (nothing for the default), and the name and logo reach the
 * client components through BrandingProvider, so the first HTML is already branded.
 */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  await connection();
  const theme = themeFromCookies(await cookies());
  const branding = await getSiteBranding();
  const css = brandingCss(branding.theme);
  const nonce = css === "" ? undefined : ((await headers()).get("x-nonce") ?? undefined);
  return (
    <html lang="en" data-theme={theme ?? undefined}>
      {css !== "" && (
        <head>
          <style nonce={nonce} data-kobe-branding="">
            {css}
          </style>
        </head>
      )}
      <body>
        <StyleNonce />
        <BrandingProvider value={branding}>
          <WorkspaceHost>{children}</WorkspaceHost>
          <NewBuildBanner />
        </BrandingProvider>
      </body>
    </html>
  );
}
