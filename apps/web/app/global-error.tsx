"use client";

import { PageError } from "../components/shell/page-error";
import "./theme.css";

/**
 * The root layout itself failed (the workspace lives there): this replaces the whole document.
 * KOBE-487: a failed chunk load shows the new-build banner with its Reload.
 */
export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <PageError error={error} reset={reset} standalone />
      </body>
    </html>
  );
}
