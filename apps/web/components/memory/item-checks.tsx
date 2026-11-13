"use client";

import { useCallback, useState } from "react";
import type { ApiError, ApiResult } from "../../lib/api/client";
import {
  checksOf,
  describeItemError,
  type CheckResults,
  type MemoryItem,
  type Overrides,
} from "../../lib/memory/items-api";
import { visible } from "../../lib/security/visible";
import { Button, Notice } from "../ui/console";

/** A refused save, with the way to save over it when the refusal allows one. */
export interface Problem {
  readonly error: ApiError;
  readonly checks: CheckResults;
  /** Saves again over this refusal's warnings (lint or Policy conflict); absent when not allowed. */
  readonly saveAnyway?: () => void;
}

type Attempt = (overrides: Overrides) => Promise<ApiResult<MemoryItem>>;

/** The override a refusal can be saved over; a secret or anything else has none. */
function overrideFor(code: string, overrides: Overrides): Overrides | null {
  if (code === "memory_lint_warning") return { ...overrides, lint: true };
  if (code === "memory_policy_conflict") return { ...overrides, policyConflict: true };
  return null;
}

/**
 * One save with the KOBE-379 checks (spec SM18): a warning comes back as a {@link Problem} the
 * editor shows next to the control, with **Save anyway** retrying with the override (kept for a
 * second refusal, so a lint override followed by a Policy conflict sends both).
 */
export function useCheckedSave() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const save = useCallback(
    async (
      attempt: Attempt,
      onSaved: (item: MemoryItem) => void,
      overrides: Overrides = {},
    ): Promise<void> => {
      setBusy(true);
      let res: ApiResult<MemoryItem>;
      try {
        res = await attempt(overrides);
      } catch {
        res = {
          ok: false,
          error: { status: 0, code: "client_error", message: "Something went wrong. Try again." },
        };
      }
      setBusy(false);
      if (res.ok) {
        setProblem(null);
        onSaved(res.data);
        return;
      }
      const error = res.error;
      const next = overrideFor(error.code, overrides);
      setProblem({
        error,
        checks: checksOf(error),
        ...(next ? { saveAnyway: () => void save(attempt, onSaved, next) } : {}),
      });
    },
    [],
  );

  const clear = useCallback(() => setProblem(null), []);
  return { busy, problem, save, clear };
}

/** The anchor of an item's row, for the near-duplicate links. */
export const itemAnchor = (id: string) => `memory-item-${id}`;

/**
 * A refused save, inline: the warnings in the server's words, near-duplicates as links to their
 * rows (statement from `known`, plain text), Policy conflicts, or the error with its way out
 * (Reload for a version conflict). Announced when it appears.
 */
export function CheckProblem({
  problem,
  known,
  busy,
  onReload,
}: {
  readonly problem: Problem;
  readonly known: ReadonlyMap<string, MemoryItem>;
  readonly busy: boolean;
  readonly onReload: () => void;
}) {
  const { error, checks, saveAnyway } = problem;
  const anyway = saveAnyway && (
    <Button size="sm" variant="primary" disabled={busy} onClick={saveAnyway}>
      Save anyway
    </Button>
  );
  if (error.code === "memory_lint_warning") {
    // A near-duplicate is shown as links when the answer names the items, else in its own words;
    // a refusal without any warning still says why (never an empty notice).
    const linked = checks.duplicates.length > 0;
    const listed = checks.warnings.filter((w) => !(linked && w.code === "near_duplicate"));
    const other = listed.length > 0 || linked ? listed : [{ code: "lint", message: error.message }];
    return (
      <Notice tone="warn" role="alert" title="Check this before saving" actions={anyway}>
        {other.length > 0 && (
          <ul aria-label="Warnings" className="m-0 ps-5">
            {other.map((w, i) => (
              <li key={`${w.code}-${i}`}>{w.message}</li>
            ))}
          </ul>
        )}
        {checks.duplicates.length > 0 && (
          <>
            <p>A similar memory is already saved here:</p>
            <ul aria-label="Similar memories" className="m-0 ps-5">
              {checks.duplicates.map((d) => {
                const item = known.get(d.id);
                return (
                  <li key={d.id}>
                    <a href={`#${itemAnchor(d.id)}`}>
                      {item ? visible(item.statement) : "A similar memory"}
                    </a>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Notice>
    );
  }
  if (error.code === "memory_policy_conflict") {
    return (
      <Notice tone="warn" role="alert" title="This may contradict Site Policy" actions={anyway}>
        <p>
          {checks.policyConflicts.length === 1
            ? "It is about the same thing as a Policy item but says otherwise."
            : `It is about the same thing as ${checks.policyConflicts.length || "some"} Policy items but says otherwise.`}{" "}
          Saving anyway is recorded.
        </p>
      </Notice>
    );
  }
  return (
    <Notice
      tone="error"
      actions={
        error.code === "memory_version_conflict" ? (
          <Button size="sm" onClick={onReload}>
            Reload
          </Button>
        ) : undefined
      }
    >
      <p>{describeItemError(error)}</p>
    </Notice>
  );
}
