"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { CLIENT_BUILD_ID } from "../../lib/build/build-id";
import {
  createBuildWatcher,
  fetchBuildId,
  setActiveWatcher,
  watchForNewBuild,
  type BuildWatcher,
} from "../../lib/build/build-watcher";
import { requestReload } from "../../lib/build/reload-draft";
import styles from "./new-build-banner.module.css";

export const RELOAD_NOTICE = "Kobe was updated. Reload to get the latest version.";

function defaultWatcher(): BuildWatcher {
  return createBuildWatcher({ current: CLIENT_BUILD_ID, fetchBuildId, now: () => Date.now() });
}

/** The browser's reload: the file editor's unsaved-changes guard (`beforeunload`) still asks. */
function browserReload(): void {
  window.location.reload();
}

/**
 * The new-build banner (KOBE-487), in the root layout on every page: a non-blocking notice that
 * the web was redeployed, with a Reload button. The page never reloads by itself; Reload keeps
 * the composer's draft (`lib/build/reload-draft.ts`) and the file editor's unsaved-changes guard
 * asks before edits are dropped. The live region is always there so the notice is announced.
 */
export function NewBuildBanner({
  watcher: given,
  reload = browserReload,
}: {
  readonly watcher?: BuildWatcher | undefined;
  readonly reload?: (() => void) | undefined;
}) {
  const [watcher] = useState(() => given ?? defaultWatcher());
  useEffect(() => {
    setActiveWatcher(watcher);
    const stop = watchForNewBuild(window, watcher);
    return () => {
      stop();
      setActiveWatcher(undefined);
    };
  }, [watcher]);
  const stale = useSyncExternalStore(watcher.subscribe, watcher.isStale, () => false);
  return <ReloadNotice shown={stale} reload={reload} />;
}

/**
 * The banner itself: an always-present live region, filled while `shown`. The error pages use it
 * directly (`app/global-error.tsx`).
 */
export function ReloadNotice({
  shown,
  reload = browserReload,
}: {
  readonly shown: boolean;
  readonly reload?: (() => void) | undefined;
}) {
  const onReload = () => {
    requestReload();
    reload();
  };
  return (
    <div role="status" className={styles.region} data-kobe-new-build>
      {shown && (
        <div className={styles.banner}>
          <p className={styles.text}>{RELOAD_NOTICE}</p>
          <button type="button" className={styles.reload} onClick={onReload}>
            Reload
          </button>
        </div>
      )}
    </div>
  );
}
