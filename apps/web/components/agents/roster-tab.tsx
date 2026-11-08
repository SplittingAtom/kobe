"use client";

import type { AgentRosterPage, AgentRosterRow, AgentRosterTab } from "@kobe/protocol";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { agentPageHref } from "../../lib/agents/redirects";
import { listRoster } from "../../lib/agents/roster-api";
import {
  editHref,
  pinLabel,
  reachItems,
  rosterStatusLabel,
  updateAvailableLabel,
  versionInEffectLabel,
} from "../../lib/agents/roster-labels";
import {
  Badge,
  Button,
  EmptyState,
  RowMenu,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  type BadgeTone,
} from "../ui/console";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useMutation, type ResourceState } from "../admin/use-resource";
import { AgentIconGlyph } from "../admin/team/agent-builder/icon-picker";
import { DangerousBadge } from "../admin/team/agent-builder/dangerous-badge";
import { useRosterActions } from "./roster-actions";

const STATUS_TONE: Readonly<Record<string, BadgeTone>> = {
  active: "done",
  proposed: "attention",
  not_published: "neutral",
  suspended_here: "attention",
  suspended_site: "attention",
  archived: "neutral",
  unavailable: "failed",
};

const EMPTY: Readonly<Record<AgentRosterTab, string>> = {
  personal: "You have no personal agents yet.",
  team: "Nothing is on this team's roster yet.",
  site: "Nothing is on the site roster yet.",
};

const CAPTION: Readonly<Record<AgentRosterTab, string>> = {
  personal: "Your personal agents",
  team: "The team's agents",
  site: "Agents for every team",
};

interface Loaded {
  readonly rows: readonly AgentRosterRow[];
  readonly nextCursor: string | null;
}

/** The tab's rows, page by page (ordered by name and id, 200 a page, §6.8). */
function useRosterRows(teamId: string, tab: AgentRosterTab) {
  const [state, setState] = useState<ResourceState<Loaded>>({ status: "loading" });
  const [generation, setGeneration] = useState(0);
  const paging = useMutation();

  useEffect(() => {
    let current = true;
    listRoster(teamId, tab).then(
      (res) => {
        if (!current) return;
        setState(
          res.ok
            ? { status: "ready", data: { rows: res.data.rows, nextCursor: res.data.nextCursor } }
            : { status: "error", error: res.error },
        );
      },
      () => {
        if (current) {
          setState({
            status: "error",
            error: {
              status: 0,
              code: "client_error",
              message: "Something went wrong. Reload the page.",
            },
          });
        }
      },
    );
    return () => {
      current = false;
    };
    // Loads on mount and on reload(); the team keys the page, the tab keys this component.
  }, [generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  async function loadMore() {
    if (state.status !== "ready" || state.data.nextCursor === null) return;
    const cursor = state.data.nextCursor;
    await paging.run(
      () => listRoster(teamId, tab, cursor),
      (page: AgentRosterPage) => {
        setState((s) =>
          s.status === "ready"
            ? {
                status: "ready",
                data: { rows: [...s.data.rows, ...page.rows], nextCursor: page.nextCursor },
              }
            : s,
        );
        return null;
      },
    );
  }

  return { state, reload, loadMore, paging };
}

/**
 * One tab of the Agents page (KOBE-569, spec agents-roster AR1, AR2): the roster's rows with the
 * viewer's actions, which the server reports per row (`row.actions`, §5); the page never decides
 * rights itself.
 */
export function RosterTab({ tab }: { readonly tab: AgentRosterTab }) {
  const access = useTeamAccess();
  const team = access.team;
  const { state, reload, loadMore, paging } = useRosterRows(team.id, tab);
  const mutation = useMutation();
  const { itemsFor, withdrawElsewhere, dialogs } = useRosterActions({
    teamId: team.id,
    teamName: team.name,
    tab,
    mutation,
    onChanged: reload,
  });

  return (
    <>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="agents">
        {({ rows, nextCursor }) =>
          rows.length === 0 ? (
            <EmptyState title={EMPTY[tab]} />
          ) : (
            <>
              <Table caption={tab === "team" ? `Agents of ${team.name}` : CAPTION[tab]}>
                <TableHead>
                  <TableRow>
                    <TableHeader>Agent</TableHeader>
                    {tab === "personal" ? (
                      <TableHeader>Reach</TableHeader>
                    ) : (
                      <TableHeader>Owner</TableHeader>
                    )}
                    <TableHeader>Version</TableHeader>
                    <TableHeader>Status</TableHeader>
                    <TableHeader>Updated</TableHeader>
                    <TableHeader>
                      <span className="sr-only">Actions</span>
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.agentId} data-agent={row.slug}>
                      <TableRowHeader>
                        <span className="inline-flex items-center gap-2">
                          {row.icon && <AgentIconGlyph name={row.icon} />}
                          {row.name}
                          {row.dangerous && <DangerousBadge />}
                        </span>
                        {row.description && (
                          <div className="text-sm font-normal text-console-muted">
                            {row.description}
                          </div>
                        )}
                      </TableRowHeader>
                      {tab === "personal" ? (
                        <TableCell>
                          <ul className="m-0 list-none p-0">
                            {reachItems(row, team).map((item) => (
                              <li key={item.key} className="flex flex-wrap items-center gap-2">
                                {item.label}
                                {item.withdrawFrom !== null && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={mutation.pending}
                                    onClick={(e) => {
                                      const from = item.withdrawFrom;
                                      if (from === null) return;
                                      void withdrawElsewhere(
                                        row,
                                        from.teamId,
                                        from.teamName,
                                        e.currentTarget,
                                      );
                                    }}
                                  >
                                    Withdraw
                                    <span className="sr-only">{` ${row.name} (${item.label})`}</span>
                                  </Button>
                                )}
                              </li>
                            ))}
                          </ul>
                        </TableCell>
                      ) : (
                        <TableCell>{ownerLabel(row)}</TableCell>
                      )}
                      <TableCell>
                        {versionInEffectLabel(row, access.user.id)}
                        {pinLabel(row) && (
                          <div className="text-sm text-console-muted">{pinLabel(row)}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>
                            {rosterStatusLabel(row, tab)}
                          </Badge>
                          {updateAvailableLabel(row) && (
                            <Badge tone="running">{updateAvailableLabel(row)}</Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        <DateTime value={row.updatedAt} compact />
                      </TableCell>
                      <TableCell className="py-1 whitespace-nowrap">
                        <span className="inline-flex items-center gap-2">
                          <OpenLink row={row} />
                          <RowMenu label={`Actions for ${row.name}`} items={itemsFor(row)} />
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {nextCursor !== null && (
                <p>
                  <Button loading={paging.pending} onClick={() => void loadMore()}>
                    Load more
                  </Button>
                </p>
              )}
              {paging.error && <MutationStatus error={paging.error} notice={null} />}
            </>
          )
        }
      </ResourceView>
      {dialogs}
    </>
  );
}

function ownerLabel(row: AgentRosterRow): string {
  if (row.kind === "gallery") return "Kobe gallery";
  if (row.kind === "team_owned") return row.ownerName ? `${row.ownerName} (team)` : "The team";
  return row.ownerName ?? "—";
}

/**
 * Edit for the owner (or, for team-owned and gallery agents, today's editors), View for anyone
 * else who may read the definition (AR14): read-only definition and versions.
 */
function OpenLink({ row }: { readonly row: AgentRosterRow }) {
  if (row.actions.edit) {
    return (
      <Link href={editHref(row)}>
        Edit
        <span className="sr-only"> {row.name}</span>
      </Link>
    );
  }
  if (row.actions.viewDefinition) {
    return (
      <Link href={agentPageHref(row.agentId)}>
        View
        <span className="sr-only"> {row.name}</span>
      </Link>
    );
  }
  return null;
}
