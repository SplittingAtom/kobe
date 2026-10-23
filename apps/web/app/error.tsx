"use client";

import { PageError } from "../components/shell/page-error";

/** A page that failed to render (KOBE-487: a failed chunk load turns the new-build banner on). */
export default function ErrorPage({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  return <PageError error={error} reset={reset} />;
}
