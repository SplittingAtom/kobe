"use client";

import { useEffect, useState, type MouseEvent } from "react";
import {
  listMySharedCases,
  withdrawSharedCase,
  type MySharedCase,
} from "../../lib/admin/api/eval-cases";
import { listPersonalAgents, listTeamAgents } from "../../lib/admin/api/team/agents";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { ResourceView } from "../admin/parts";
import {
  formatDay,
  STATUS_LABEL,
  STATUS_TONE,
  versionLabel,
} from "../admin/team/eval-cases/case-format";
import { CaseContent } from "../admin/team/eval-cases/case-content";
import { useFocusAfterRemoval } from "../admin/use-focus-after-removal";
import { useMutation, useResource } from "../admin/use-resource";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  eventTrigger,
  FOCUS_RING,
  PageHeader,
  Section,
  useConfirm,
} from "../ui/console";

const HEADING = "my-shared-cases";

/** Agent names by id, best effort: a case keeps its agent's id even if the list can't be read. */
function useAgentNames(teamId: string): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let current = true;
    void Promise.all([listTeamAgents(teamId), listPersonalAgents(teamId)])
      .then((lists) => {
        if (!current) return;
        const agents = lists.flatMap((res) => (res.ok ? res.data : []));
        setNames(new Map(agents.map((a) => [a.id, a.name])));
      })
      // Names only: a list that can't be read (an error answer or a throw) leaves the neutral
      // fallback name, and the cases themselves come from their own request, whose errors show.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [teamId]);
  return names;
}

/**
 * My area, Shared cases (KOBE-276): the answers the member shared with an agent's owner as eval
 * cases in this team, with what was shared and the review status, and Withdraw. The list holds
 * every shared case, also those whose rating was cleared since (the chat offers Withdraw only
 * while the rating exists). Withdrawing deletes the copy; it always answers the same.
 */
export function MySharedCasesPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => listMySharedCases(teamId));
  const names = useAgentNames(teamId);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const ids = state.status === "ready" ? state.data.map((c) => c.id) : null;
  const focus = useFocusAfterRemoval(ids, HEADING);

  async function withdraw(item: MySharedCase, index: number, e: MouseEvent<HTMLButtonElement>) {
    const trigger = eventTrigger(e);
    const yes = await confirm(
      {
        title: "Withdraw this shared case?",
        description:
          "The agent's owner no longer sees it and it leaves the agent's evaluations. Your rating stays as it is.",
        confirmLabel: "Withdraw",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => withdrawSharedCase(teamId, item.id),
      () => "Withdrawn.",
    );
    if (done) {
      focus.removed(item.id, index);
      reload();
    } else {
      // The button was disabled while the request ran, which can drop focus: back to it.
      requestAnimationFrame(() => trigger?.focus());
    }
  }

  return (
    <>
      <PageHeader
        title="Shared cases"
        description="Answers you rated down and shared with an agent's owner as eval cases in this team. The owner sees what you shared, never your name; your own words can still say who you are. Withdraw a case to delete the copy."
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <Section id={HEADING} title="Your shared cases">
        <div ref={focus.container}>
          <ResourceView state={state} label="your shared cases">
            {(cases) =>
              cases.length === 0 ? (
                <EmptyState title="You haven't shared any cases.">
                  After a thumbs down in your own conversation, Share as an eval case… lets the
                  agent&apos;s owner test the next version against that answer.
                </EmptyState>
              ) : (
                <ul className="m-0 grid list-none gap-3 p-0">
                  {cases.map((c, i) => (
                    <li key={c.id}>
                      <SharedCaseCard
                        item={c}
                        agentName={names.get(c.agent.id)}
                        pending={mutation.pending}
                        onWithdraw={(e) => void withdraw(c, i, e)}
                      />
                    </li>
                  ))}
                </ul>
              )
            }
          </ResourceView>
        </div>
      </Section>
      {confirmDialog}
    </>
  );
}

function SharedCaseCard({
  item,
  agentName,
  pending,
  onWithdraw,
}: {
  readonly item: MySharedCase;
  readonly agentName: string | undefined;
  readonly pending: boolean;
  readonly onWithdraw: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const agent = agentName ?? (item.agent.scope === "personal" ? "Your agent" : "A team agent");
  const day = formatDay(item.sharedAt);
  return (
    <Card title={`${agent}, ${versionLabel(item.agent.version)}`}>
      <p className="m-0 mb-2 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
        <span>
          Shared on <time dateTime={item.sharedAt.slice(0, 10)}>{day}</time>
        </span>
      </p>
      <details className="mb-3">
        <summary className={`cursor-pointer rounded-sm ${FOCUS_RING}`}>What you shared</summary>
        <div className="mt-2">
          <CaseContent content={item.content} />
        </div>
      </details>
      <Button variant="danger" size="sm" data-remove="" disabled={pending} onClick={onWithdraw}>
        Withdraw
        <span className="sr-only">
          {" "}
          the case shared on {day} with {agent}
        </span>
      </Button>
    </Card>
  );
}
