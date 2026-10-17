"use client";

import Link from "next/link";
import { errorKind, type ApiError } from "../../lib/api/client";
import { consoleHref } from "../../lib/admin/nav/registry";
import { Button, Notice } from "../ui/console";

/**
 * Renders an API error with the way out it calls for. The text is the server's own message for
 * 4xx answers (written for people), a generic one otherwise (lib/api/client.ts).
 */
export function ErrorNotice({ error }: { readonly error: ApiError }) {
  const kind = errorKind(error);
  return (
    <Notice tone="error">
      <p>{error.message}</p>
      {kind === "signIn" && (
        <p>
          <Link href="/sign-in">Sign in</Link>
        </p>
      )}
      {kind === "forbidden" && (
        <p>Your access may have changed. Ask a site or team admin if you need it.</p>
      )}
      {kind === "chooseTeam" && (
        <p>
          <Link href="/">Choose a team</Link> with the team switcher, then come back.
        </p>
      )}
      {kind === "reload" && (
        <p>
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </p>
      )}
      {kind === "isolation" && (
        <p>
          Agents are disabled until the cluster has a gVisor or Kata runtime. Site admins can see
          the fix on the <Link href={`${consoleHref("site")}/isolation`}>Isolation</Link> page.
        </p>
      )}
    </Notice>
  );
}

/** A mutation's outcome: its error, or a short success notice announced politely. */
export function MutationStatus({
  error,
  notice,
}: {
  readonly error: ApiError | null;
  readonly notice: string | null;
}) {
  return (
    <>
      {error && <ErrorNotice error={error} />}
      {/* On the page from the start, so screen readers announce the notice when it appears. */}
      <div role="status">{notice && <Notice tone="success">{notice}</Notice>}</div>
    </>
  );
}
