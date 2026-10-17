"use client";

import Link from "next/link";
import { listAgentEvalCases } from "../../../../lib/admin/api/eval-cases";
import { Button, Section } from "../../../ui/console";
import { ErrorNotice } from "../../error-notice";
import { useResource } from "../../use-resource";
import { casesHref, type AgentScope } from "./case-format";

/** Not the agent's owner (403, team admins included) or a gone agent: no section at all. */
const HIDDEN = new Set([403, 404]);

/**
 * On the agent's page, for its owner only (KOBE-276): how many shared cases wait for review and
 * how many are accepted, with the way to the review page. Shown once the server answers 200.
 */
export function SharedCasesSummary({
  teamId,
  agentId,
  scope,
}: {
  readonly teamId: string;
  readonly agentId: string;
  readonly scope: AgentScope;
}) {
  const { state } = useResource(() => listAgentEvalCases(teamId, agentId));
  if (state.status === "loading") return null;
  if (state.status === "error" && HIDDEN.has(state.error.status)) return null;
  const open = state.status === "ready" ? state.data.cases.filter((c) => c.status === "open") : [];
  return (
    <Section
      title="Shared cases"
      description="Answers members rated down and shared with you as eval cases. Accepted cases run in every gated publish."
      actions={
        <Button asChild size="sm">
          <Link href={casesHref(scope, agentId)}>Review shared cases</Link>
        </Button>
      }
    >
      {state.status === "error" ? (
        <ErrorNotice error={state.error} />
      ) : (
        <p className="m-0">
          {open.length === 0 ? "None waiting for review." : `${open.length} waiting for review.`}{" "}
          {state.data.accepted} of {state.data.maxAccepted} accepted.
        </p>
      )}
    </Section>
  );
}
