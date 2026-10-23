"use client";

import { useEffect } from "react";
import { isChunkLoadError, noteChunkLoadError } from "../../lib/build/build-watcher";
import { ReloadNotice } from "./new-build-banner";
import styles from "./new-build-banner.module.css";

/**
 * What the error pages show (`app/error.tsx`, `app/global-error.tsx`). A code chunk that failed to
 * load after a deploy (KOBE-487 ac-5) needs a reload, not a broken page: inside the root layout it
 * turns the layout's new-build banner on; in place of the layout (`standalone`) it shows that
 * banner itself. Any other error offers to render the part again.
 */
export function PageError({
  error,
  reset,
  standalone = false,
  reload,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
  readonly standalone?: boolean;
  readonly reload?: (() => void) | undefined;
}) {
  const chunk = isChunkLoadError(error);
  useEffect(() => {
    if (chunk && !standalone) noteChunkLoadError();
  }, [chunk, standalone]);
  if (chunk) return standalone ? <ReloadNotice shown reload={reload} /> : null;
  return (
    <div role="alert" className={styles.failed}>
      <p className={styles.text}>Something went wrong.</p>
      <button type="button" className={styles.reload} onClick={reset}>
        Try again
      </button>
    </div>
  );
}
