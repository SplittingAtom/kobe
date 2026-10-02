"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getIsolation } from "../../lib/admin/api/install/isolation";
import styles from "./admin.module.css";

/** Fired by the Isolation page after a re-check, with `detail` = the new state. */
export const ISOLATION_EVENT = "kobe:isolation";

/**
 * Spec D4: without a gVisor/Kata runtime "the admin console shows the fix". Install pages show
 * this banner while agents are disabled; the Isolation page has the details and the fix.
 */
export function IsolationBanner({ hidden }: { readonly hidden: boolean }) {
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const update = (e: Event) => setMissing((e as CustomEvent<string>).detail === "missing");
    window.addEventListener(ISOLATION_EVENT, update);
    return () => window.removeEventListener(ISOLATION_EVENT, update);
  }, []);

  useEffect(() => {
    let current = true;
    getIsolation().then(
      (res) => {
        if (current) setMissing(res.ok && res.data.state === "missing");
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);

  if (!missing || hidden) return null;
  return (
    <div role="alert" className={styles.banner}>
      <strong>Agents are disabled:</strong> the isolation runtime is missing.{" "}
      <Link href="/admin/install/isolation">See how to fix it</Link>.
    </div>
  );
}
