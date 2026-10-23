"use client";

import { useState } from "react";
import {
  compareWithKobe,
  resetToKobe,
  type KobeCompare,
  type KobeState,
} from "../../../lib/admin/api/site/catalog-edit";
import { Badge, Button, Notice, eventTrigger, useConfirm } from "../../ui/console";
import { ErrorNotice } from "../error-notice";
import { useMutation } from "../use-resource";
import { ReviewDiff } from "./skill-review-diff";

/**
 * A detached Kobe skill (KOBE-495): a Site admin's edit stopped the Kobe seed publishing it. When
 * Kobe ships a version above the one it was detached from, the console says so; Compare shows the
 * shipped files against the skill's newest version, and Reset to Kobe (asks first) re-attaches it
 * when the shipped version is above every Site version (the server says why when it isn't).
 */
export function DetachedBadge({ kobe }: { readonly kobe: KobeState | null }) {
  if (!kobe?.detached) return null;
  return (
    <Badge tone="accent" title="Edited by a Site admin: Kobe releases no longer update it">
      Detached
    </Badge>
  );
}

export function KobePanel({
  skillId,
  name,
  kobe,
  onReset,
}: {
  readonly skillId: string;
  readonly name: string;
  readonly kobe: KobeState | null;
  readonly onReset: () => void;
}) {
  const [comparison, setComparison] = useState<KobeCompare | null>(null);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  if (!kobe?.detached) return null;

  async function compare(): Promise<void> {
    if (comparison) {
      setComparison(null);
      return;
    }
    await mutation.run(async () => {
      const res = await compareWithKobe(skillId);
      if (res.ok) setComparison(res.data);
      return res;
    });
  }

  async function reset(trigger: HTMLElement | null): Promise<void> {
    const yes = await confirm(
      {
        title: `Reset ${name} to Kobe?`,
        description:
          "Kobe publishes its shipped version as the newest one and releases update the skill again. The Site's versions stay in the catalog; a site draft is discarded.",
        confirmLabel: "Reset to Kobe",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => resetToKobe(skillId),
      (r) => `Reset to Kobe: ${name} follows Kobe's ${r.shippedSemver} again.`,
    );
    if (done) onReset();
  }

  return (
    <Notice tone="info">
      <p className="m-0">
        {kobe.updateAvailable
          ? `A newer Kobe version of ${name} is available (${kobe.shippedVersion ?? ""}; it was detached from ${kobe.detachedFromVersion ?? ""}).`
          : `${name} is detached from Kobe (since ${kobe.detachedFromVersion ?? "its first edit"}): Kobe releases no longer update it.`}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" disabled={mutation.pending} onClick={() => void compare()}>
          {comparison ? "Hide comparison" : "Compare"}
          <span className="sr-only"> {name} with Kobe&apos;s shipped version</span>
        </Button>
        <Button size="sm" disabled={mutation.pending} onClick={(e) => void reset(eventTrigger(e))}>
          Reset to Kobe<span className="sr-only"> ({name})</span>
        </Button>
      </div>
      {mutation.error && <ErrorNotice error={mutation.error} />}
      {mutation.notice && <p role="status">{mutation.notice}</p>}
      {comparison && (
        <div className="mt-3">
          <p className="m-0 mb-2 text-sm">
            Kobe ships {comparison.shipped.semver}; the newest version is{" "}
            {comparison.current.semver} ({comparison.current.publisher}). Added lines are
            Kobe&apos;s.
          </p>
          <ReviewDiff
            diff={{
              ...comparison.diff,
              against: { id: comparison.current.id, semver: comparison.current.semver },
            }}
          />
        </div>
      )}
      {confirmDialog}
    </Notice>
  );
}
