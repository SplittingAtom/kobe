"use client";

import { useEffect, useState } from "react";
import { useReportWebVitals } from "next/web-vitals";
import {
  createVitalsQueue,
  isReportedRoute,
  postVitals,
  toReport,
  type VitalReport,
} from "../../lib/telemetry/web-vitals";

/** A queued report waits at most this long while the page stays visible. */
const FLUSH_EVERY_MS = 10_000;

/**
 * Web Vitals and Next's render timings for every page (KOBE-525), in the root layout: batched,
 * sent when the page is hidden (or every few seconds) to `POST /v1/telemetry/web-vitals`, which
 * records them as spans. Renders nothing. Signed-out pages report nothing.
 */
export function WebVitalsReporter({
  send = postVitals,
}: {
  readonly send?: ((reports: readonly VitalReport[]) => void) | undefined;
}) {
  const [queue] = useState(() => createVitalsQueue(send));
  useReportWebVitals((metric) => {
    const pathname = window.location.pathname;
    if (!isReportedRoute(pathname)) return;
    const report = toReport(metric, pathname);
    if (report) queue.add(report);
  });
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") queue.flush();
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", queue.flush);
    const timer = window.setInterval(queue.flush, FLUSH_EVERY_MS);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", queue.flush);
      window.clearInterval(timer);
      queue.flush();
    };
  }, [queue]);
  return null;
}
