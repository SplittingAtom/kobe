import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Kobe",
  description: "Self-hosted conversational agent platform",
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
