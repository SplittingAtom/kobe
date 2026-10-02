"use client";

import Link from "next/link";
import { errorKind, type ApiError } from "../../lib/api/client";
import styles from "./admin.module.css";

/**
 * Renders an API error with the way out it calls for. The text is the server's own message for
 * 4xx answers (written for people), a generic one otherwise (lib/api/client.ts).
 */
export function ErrorNotice({ error }: { readonly error: ApiError }) {
  const kind = errorKind(error);
  return (
    <div role="alert" className={styles.error}>
      <p>{error.message}</p>
      {kind === "signIn" && (
        <p>
          <Link href="/sign-in">Sign in</Link>
        </p>
      )}
      {kind === "forbidden" && (
        <p>Your access may have changed. Ask an install or team admin if you need it.</p>
      )}
      {kind === "chooseTeam" && (
        <p>
          <Link href="/">Choose a team</Link> with the team switcher, then come back.
        </p>
      )}
      {kind === "reload" && (
        <p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </p>
      )}
      {kind === "isolation" && (
        <p>
          Agents are disabled until the cluster has a gVisor or Kata runtime. Install admins can see
          the fix on the <Link href="/admin/install/isolation">Isolation</Link> page.
        </p>
      )}
    </div>
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
      <p role="status" className={styles.notice}>
        {notice ?? ""}
      </p>
    </>
  );
}
