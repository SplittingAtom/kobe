"use client";

import { useEffect, useRef } from "react";

/**
 * Keeps keyboard focus on the list after a row is removed (KOBE-294 S3, as on Team
 * Invitations): once the reloaded list no longer holds the row, focus moves to the next row's
 * remove control (or the last one's), else to `fallbackId` (a Section heading, focusable from
 * code). `ids` is the list's ids, or null while it loads. Mark each row's control `data-remove=""`
 * inside `container`, and call `removed(id, index)` once the server has removed the row.
 */
export function useFocusAfterRemoval(ids: readonly string[] | null, fallbackId: string) {
  const container = useRef<HTMLDivElement>(null);
  const pending = useRef<{ readonly id: string; readonly index: number } | null>(null);

  useEffect(() => {
    const after = pending.current;
    if (after === null || ids === null || ids.includes(after.id)) return;
    pending.current = null;
    const controls = [
      ...(container.current?.querySelectorAll<HTMLElement>("[data-remove]") ?? []),
    ];
    (controls[Math.min(after.index, controls.length - 1)] ?? document.getElementById(fallbackId))
      ?.focus();
  }, [ids, fallbackId]);

  return {
    container,
    removed: (id: string, index: number) => {
      pending.current = { id, index };
    },
  };
}
