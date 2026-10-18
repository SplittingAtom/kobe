"use client";

import Link from "next/link";
import { listAgentEvalCases, type AgentEvalCases } from "../../../../lib/admin/api/eval-cases";
import { REASON_LABELS } from "../../../../lib/chat/feedback";
import {
  Badge,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { ResourceView } from "../../parts";
import { useResource } from "../../use-resource";
import {
  agentHref,
  caseHref,
  formatDay,
  STATUS_LABEL,
  STATUS_TONE,
  versionLabel,
  type AgentScope,
} from "./case-format";

/**
 * The agent owner's review list of shared eval cases (KOBE-276). The server answers only the
 * agent's owner (403 otherwise, team admins included) and never says who shared a case: each row
 * gives the UTC day it was shared, the version that answered, the reasons and the prompt's start.
 * Rows stay in the server's order (status, then day, then a random id), which never tells the
 * order cases came in.
 */
export function SharedCasesPage({
  scope,
  agentId,
}: {
  readonly scope: AgentScope;
  readonly agentId: string;
}) {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => listAgentEvalCases(teamId, agentId));
  return (
    <>
      <PageHeader
        title="Shared cases"
        back={<Link href={agentHref(scope, agentId)}>Back to the agent</Link>}
        description="Answers members rated down and chose to share with you. You never see who shared a case, only the day (UTC); a case shows here once that day has ended. Accepted cases run in every gated publish of this agent."
      />
      <ResourceView state={state} label="shared cases">
        {(data) => <CaseList scope={scope} agentId={agentId} data={data} />}
      </ResourceView>
    </>
  );
}

function CaseList({
  scope,
  agentId,
  data,
}: {
  readonly scope: AgentScope;
  readonly agentId: string;
  readonly data: AgentEvalCases;
}) {
  if (data.cases.length === 0) {
    return (
      <EmptyState title="No shared cases yet.">
        A member who rates an answer down in their own conversation can share it here as an eval
        case.
      </EmptyState>
    );
  }
  return (
    <>
      <p className="m-0 mb-3">
        {data.accepted} of {data.maxAccepted} accepted.
      </p>
      <Table caption="Shared cases" hideCaption>
        <TableHead>
          <TableRow>
            <TableHeader>Shared on</TableHeader>
            <TableHeader>Version</TableHeader>
            <TableHeader>Reasons</TableHeader>
            <TableHeader>Prompt</TableHeader>
            <TableHeader>Status</TableHeader>
            <TableHeader>
              <span className="sr-only">Review</span>
            </TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {data.cases.map((c) => {
            const day = formatDay(c.sharedOn);
            return (
              <TableRow key={c.id}>
                <TableRowHeader className="whitespace-nowrap">
                  <time dateTime={c.sharedOn}>{day}</time>
                </TableRowHeader>
                <TableCell>{versionLabel(c.agentVersion)}</TableCell>
                <TableCell>
                  {c.reasons.length === 0 ? "—" : c.reasons.map((r) => REASON_LABELS[r]).join(", ")}
                </TableCell>
                <TableCell className="max-w-96">
                  <span className="line-clamp-2 break-words">{c.promptExcerpt}</span>
                </TableCell>
                <TableCell>
                  <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                </TableCell>
                <TableCell>
                  <Link href={caseHref(scope, agentId, c.id)}>
                    Review<span className="sr-only"> the case shared on {day}</span>
                  </Link>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
