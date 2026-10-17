"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import {
  EVAL_CASE_EXPECTED_MAX_CHARS,
  getAgentEvalCase,
  reviewAgentEvalCase,
  type AgentEvalCase,
  type EvalCaseReview,
} from "../../../../lib/admin/api/eval-cases";
import type { ApiError } from "../../../../lib/api/client";
import { REASON_LABELS } from "../../../../lib/chat/feedback";
import { Badge, Button, Field, PageHeader, Section, Textarea } from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { MutationStatus } from "../../error-notice";
import { ResourceView } from "../../parts";
import { useMutation, useResource } from "../../use-resource";
import { CaseContent } from "./case-content";
import {
  casesHref,
  formatDay,
  STATUS_LABEL,
  STATUS_TONE,
  versionLabel,
  type AgentScope,
} from "./case-format";

/** The review errors in words that say what to do (the server's codes, KOBE-276). */
const REVIEW_ERRORS: Readonly<Record<string, string>> = {
  expected_behaviour_required: "Write the expected behaviour before accepting the case.",
  case_limit: "This agent already has the most accepted cases it can run. Dismiss one first.",
  case_not_found: "This case is no longer shared. It may have been withdrawn.",
};

const reviewError = (error: ApiError | null): ApiError | null =>
  error && REVIEW_ERRORS[error.code]
    ? { ...error, message: REVIEW_ERRORS[error.code] ?? "" }
    : error;

/**
 * One shared case for the agent's owner (KOBE-276): the copied exchange as plain text, and the
 * review: accept with an expected behaviour (or rubric) the eval grades new answers against,
 * dismiss, reopen, or edit the expected behaviour. No sharer, and the day only.
 */
export function SharedCasePage({
  scope,
  agentId,
  caseId,
}: {
  readonly scope: AgentScope;
  readonly agentId: string;
  readonly caseId: string;
}) {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => getAgentEvalCase(teamId, agentId, caseId));
  return (
    <>
      <PageHeader
        title="Shared case"
        back={<Link href={casesHref(scope, agentId)}>All shared cases</Link>}
      />
      <ResourceView state={state} label="the case">
        {(found) => <Review teamId={teamId} agentId={agentId} initial={found} />}
      </ResourceView>
    </>
  );
}

function Review({
  teamId,
  agentId,
  initial,
}: {
  readonly teamId: string;
  readonly agentId: string;
  readonly initial: AgentEvalCase;
}) {
  const [current, setCurrent] = useState(initial);
  const [expected, setExpected] = useState(initial.expectedBehaviour ?? "");
  const [missing, setMissing] = useState(false);
  const mutation = useMutation();
  const trimmed = expected.trim();
  const edited = trimmed !== (current.expectedBehaviour ?? "");

  async function send(review: EvalCaseReview, done: string) {
    await mutation.run(
      async () => {
        const res = await reviewAgentEvalCase(teamId, agentId, current.id, review);
        if (res.ok) {
          setCurrent(res.data);
          setExpected(res.data.expectedBehaviour ?? "");
        }
        return res;
      },
      () => done,
    );
  }

  function accept(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (trimmed === "") {
      setMissing(true);
      return;
    }
    setMissing(false);
    void send(
      { status: "accepted", expectedBehaviour: trimmed },
      "Accepted. The case runs in the next gated publish.",
    );
  }

  const accepted = current.status === "accepted";
  return (
    <>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 [&_dd]:m-0 [&_dt]:font-medium">
        <dt>Status</dt>
        <dd>
          <Badge tone={STATUS_TONE[current.status]}>{STATUS_LABEL[current.status]}</Badge>
        </dd>
        <dt>Shared on</dt>
        <dd>
          <time dateTime={current.sharedOn}>{formatDay(current.sharedOn)}</time>
        </dd>
        <dt>Version</dt>
        <dd>{versionLabel(current.agentVersion)}</dd>
        <dt>Reasons</dt>
        <dd>
          {current.reasons.length === 0
            ? "—"
            : current.reasons.map((r) => REASON_LABELS[r]).join(", ")}
        </dd>
      </dl>
      <Section title="What was shared">
        <CaseContent content={current.content} />
      </Section>
      <Section
        title="Review"
        description="An accepted case replays this prompt against each new version; the evaluation's model then checks the answer against the expected behaviour."
      >
        <MutationStatus error={reviewError(mutation.error)} notice={mutation.notice} />
        <form onSubmit={accept} noValidate className="grid max-w-[42rem] gap-3">
          <Field
            label="Expected behaviour"
            hint={`What a good answer does, or a rubric to check it against. Needed to accept; up to ${EVAL_CASE_EXPECTED_MAX_CHARS.toLocaleString("en-US")} characters.`}
            error={missing ? "Write the expected behaviour before accepting the case." : undefined}
          >
            <Textarea
              className="min-h-32 w-full resize-y"
              maxLength={EVAL_CASE_EXPECTED_MAX_CHARS}
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            {!accepted && (
              <Button type="submit" variant="primary" loading={mutation.pending}>
                Accept
              </Button>
            )}
            {edited && (accepted ? trimmed !== "" : true) && (
              <Button
                disabled={mutation.pending}
                onClick={() =>
                  void send(
                    { expectedBehaviour: trimmed === "" ? null : trimmed },
                    "Expected behaviour saved.",
                  )
                }
              >
                Save expected behaviour
              </Button>
            )}
            {current.status !== "dismissed" && (
              <Button
                disabled={mutation.pending}
                onClick={() => void send({ status: "dismissed" }, "Dismissed. It won't run.")}
              >
                Dismiss
              </Button>
            )}
            {current.status !== "open" && (
              <Button
                disabled={mutation.pending}
                onClick={() => void send({ status: "open" }, "Reopened for review.")}
              >
                Reopen
              </Button>
            )}
          </div>
        </form>
      </Section>
    </>
  );
}
