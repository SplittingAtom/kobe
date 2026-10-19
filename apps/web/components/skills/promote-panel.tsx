"use client";

import {
  previewPromotion,
  promoteVersion,
  type PromoteSource,
} from "../../lib/skills/promotions-api";
import { MutationStatus } from "../admin/error-notice";
import { ResourceView } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
import { Button } from "../ui/console";
import { Refusals, WhatLeaves } from "./what-leaves";

/**
 * Promote to Site for one version (KOBE-333, SK19): what leaves the team, the Site's rules with
 * their reasons, then Promote. A Builder's promotion of a team skill may wait for a Team admin.
 */
export function PromotePanel({
  teamId,
  source,
  onDone,
}: {
  readonly teamId: string;
  readonly source: PromoteSource;
  readonly onDone: () => void;
}) {
  const { state } = useResource(() => previewPromotion(teamId, source));
  const mutation = useMutation();
  const promote = () =>
    mutation.run(
      () => promoteVersion(teamId, source),
      (r) =>
        r.state === "submitted"
          ? "Submitted to the Site Registry for review."
          : "Sent to your Team admins: they confirm before it leaves the team.",
    );
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Promote to Site">
      <ResourceView state={state} label="what would leave the team">
        {(preview) => (
          <>
            <WhatLeaves preview={preview} />
            <Refusals preview={preview} />
            <div>
              <Button
                variant="primary"
                size="sm"
                disabled={
                  mutation.pending || preview.refusals.length > 0 || mutation.notice !== null
                }
                onClick={() => void promote()}
              >
                Promote
              </Button>{" "}
              <Button variant="ghost" size="sm" onClick={onDone}>
                Close
              </Button>
            </div>
          </>
        )}
      </ResourceView>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </div>
  );
}
