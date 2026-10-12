import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Kobe",
  description: "Self-hosted conversational agent platform",
};

/** The on-screen keyboard shrinks the layout, so the chat's composer stays above it (KOBE-205). */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

/**
 * Rendered per request: the CSP nonce (`proxy.ts`) only exists at request time, and Next puts it
 * on its scripts while rendering. Pages hold no user data on the server either way.
 */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  await connection();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
