"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { scanDraft, type ScanPreview } from "../../lib/skills/drafts-api";

/**
 * The live scan preview of a draft (KOBE-321, SK12; review S1/S2). `rescan()` after every write
 * asks for the scan of the newest revision and cancels the request before it (the server cancels
 * that worker too). A busy answer (the pool is full, or a save took the slot) is asked again after
 * {@link SCAN_BUSY_RETRY_MS}; a scan that couldn't finish is "unavailable", never a Block, and is
 * asked again a few times; files that don't form a package are a package problem, not a verdict.
 */
export const SCAN_BUSY_RETRY_MS = 1000;
/** Busy answers in a row before the page stops asking until the next change. */
export const SCAN_BUSY_TRIES = 10;
export const SCAN_UNAVAILABLE_RETRY_MS = 5000;
export const SCAN_UNAVAILABLE_TRIES = 3;

export type ScanState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly last: ScanPreview | null }
  | { readonly status: "ready"; readonly scan: ScanPreview }
  | {
      /** busy and unavailable: asked again shortly; problem: the files aren't a package. */
      readonly status: "busy" | "unavailable" | "problem" | "error";
      readonly last: ScanPreview | null;
      readonly message: string;
    };

export function useScanPreview(
  teamId: string,
  id: string,
  currentRev: () => number,
): { readonly scan: ScanState; readonly rescan: () => void } {
  const [scan, setScan] = useState<ScanState>({ status: "idle" });
  const last = useRef<ScanPreview | null>(null);
  const abort = useRef<AbortController | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tries = useRef({ busy: 0, unavailable: 0 });
  // A write after the page has gone (the unmount flush) needs no scan.
  const gone = useRef(false);

  const run = useCallback(async () => {
    if (gone.current) return;
    if (retry.current) clearTimeout(retry.current);
    abort.current?.abort();
    const mine = new AbortController();
    abort.current = mine;
    setScan({ status: "running", last: last.current });
    const res = await scanDraft(teamId, id, mine.signal);
    if (mine.signal.aborted) return;
    const later = (ms: number) => {
      retry.current = setTimeout(() => void run(), ms);
    };
    if (res.ok) {
      tries.current = { busy: 0, unavailable: 0 };
      // An older revision's scan: the scan of the newer one is on its way.
      if (res.data.rev < currentRev()) return;
      last.current = res.data;
      setScan({ status: "ready", scan: res.data });
      return;
    }
    const { code, message } = res.error;
    if (code === "scan_busy" && tries.current.busy < SCAN_BUSY_TRIES) {
      tries.current.busy += 1;
      later(SCAN_BUSY_RETRY_MS);
      setScan({ status: "busy", last: last.current, message: "Scan busy, trying again…" });
    } else if (code === "scan_unavailable" && tries.current.unavailable < SCAN_UNAVAILABLE_TRIES) {
      tries.current.unavailable += 1;
      later(SCAN_UNAVAILABLE_RETRY_MS);
      setScan({
        status: "unavailable",
        last: last.current,
        message: "Scan unavailable, retrying…",
      });
    } else if (code === "invalid_package") {
      setScan({ status: "problem", last: last.current, message });
    } else {
      setScan({ status: "error", last: last.current, message });
    }
  }, [teamId, id, currentRev]);

  const rescan = useCallback(() => {
    tries.current = { busy: 0, unavailable: 0 };
    void run();
  }, [run]);

  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      if (retry.current) clearTimeout(retry.current);
      abort.current?.abort();
    };
  }, []);

  return { scan, rescan };
}
