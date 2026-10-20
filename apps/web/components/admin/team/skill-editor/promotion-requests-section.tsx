"use client";

import { useState } from "react";
import {
  confirmPromotionRequest,
  declinePromotionRequest,
  getPromotionRequest,
  listPromotionRequests,
  type PromotionRequest,
} from "../../../../lib/skills/promotions-api";
import { Refusals, WhatLeaves } from "../../../skills/what-leaves";
import { Button, EmptyState, Field, Section, TextInput } from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { MutationStatus } from "../../error-notice";
import { DateTime, ResourceView } from "../../parts";
import { useMutation, useResource } from "../../use-resource";

/**
 * Builders' Promote to Site requests (KOBE-333, SK19), for Team admins: each shows exactly what
 * would leave the team before a one-click Confirm, or a Decline with an optional note.
 */
export function PromotionRequestsSection() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const isAdmin = access.permissions.includes("team.skills.review");
  const { state, reload } = useResource(() => listPromotionRequests(teamId));
  const [open, setOpen] = useState<string | null>(null);
  if (!isAdmin) return null;
  return (
    <Section id="promotion-requests" title="Promote to Site requests">
      <ResourceView state={state} label="promotion requests">
        {(requests) =>
          requests.length === 0 ? (
            <EmptyState title="No Builder waits for a promotion." />
          ) : (
            <ul className="m-0 flex flex-col gap-3">
              {requests.map((r) => (
                <li key={r.id}>
                  <Button
                    variant="ghost"
                    aria-expanded={open === r.id}
                    onClick={() => setOpen(open === r.id ? null : r.id)}
                  >
                    {`Version ${r.semver}`}
                  </Button>{" "}
                  <DateTime value={r.createdAt} compact />
                  {open === r.id && (
                    <RequestDetail
                      teamId={teamId}
                      request={r}
                      onDecided={() => {
                        setOpen(null);
                        reload();
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>
    </Section>
  );
}

function RequestDetail({
  teamId,
  request,
  onDecided,
}: {
  readonly teamId: string;
  readonly request: PromotionRequest;
  readonly onDecided: () => void;
}) {
  const { state } = useResource(() => getPromotionRequest(teamId, request.id));
  const mutation = useMutation();
  const [note, setNote] = useState("");
  const decide = async (confirm: boolean) => {
    const done = await mutation.run(
      () =>
        confirm
          ? confirmPromotionRequest(teamId, request.id)
          : declinePromotionRequest(teamId, request.id, note),
      () => (confirm ? "Confirmed: submitted to the Site Registry." : "Declined."),
    );
    if (done) onDecided();
  };
  return (
    <div className="mt-2 flex flex-col gap-2" role="group" aria-label={`Request ${request.semver}`}>
      <ResourceView state={state} label="what would leave the team">
        {(preview) => (
          <>
            <WhatLeaves preview={preview} />
            <Refusals preview={preview} />
            <div>
              <Button
                variant="primary"
                size="sm"
                disabled={mutation.pending || preview.refusals.length > 0}
                onClick={() => void decide(true)}
              >
                Confirm
              </Button>
            </div>
            <Field label="Note to the Builder (optional)">
              <TextInput value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div>
              <Button
                variant="danger"
                size="sm"
                disabled={mutation.pending}
                onClick={() => void decide(false)}
              >
                Decline
              </Button>
            </div>
          </>
        )}
      </ResourceView>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </div>
  );
}
