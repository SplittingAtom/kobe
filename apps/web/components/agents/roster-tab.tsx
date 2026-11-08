"use client";

import type { AgentRosterRow, AgentRosterTab } from "@kobe/protocol";
import Link from "next/link";
import { agentPageHref } from "../../lib/agents/redirects";
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
  type RowMenuItem,
} from "../ui/console";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useMutation } from "../admin/use-resource";
import { AgentIconGlyph } from "../admin/team/agent-builder/icon-picker";
import { DangerousBadge } from "../admin/team/agent-builder/dangerous-badge";
import { useRosterActions } from "./roster-actions";
import { useRosterRows } from "./use-roster-rows";

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

function caption(tab: AgentRosterTab, teamName: string): string {
  if (tab === "team") return `Agents of ${teamName}`;
  return tab === "personal" ? "Your personal agents" : "Agents for every team";
}

type WithdrawElsewhere = ReturnType<typeof useRosterActions>["withdrawElsewhere"];

/**
 * One tab of the Agents page (KOBE-569, spec agents-roster AR1, AR2): the roster's rows with the
 * viewer's actions, which the server reports per row (`row.actions`, §5); the page never decides
 * rights itself.
 */
export function RosterTab({ tab }: { readonly tab: AgentRosterTab }) {
  const team = useTeamAccess().team;
  const roster = useRosterRows(team.id, tab);
  const mutation = useMutation();
  const actions = useRosterActions({
    teamId: team.id,
    teamName: team.name,
    tab,
    mutation,
    onChanged: () => void roster.refresh(),
  });
  return (
    <>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={roster.state} label="agents">
        {() =>
          roster.rows.length === 0 ? (
            <EmptyState title={EMPTY[tab]} />
          ) : (
            <RosterTable
              tab={tab}
              rows={roster.rows}
              itemsFor={actions.itemsFor}
              withdrawElsewhere={actions.withdrawElsewhere}
              busy={mutation.pending}
            />
          )
        }
      </ResourceView>
      {roster.nextCursor !== null && (
        <p>
          <Button loading={roster.paging.pending} onClick={() => void roster.loadMore()}>
            Load more
          </Button>
        </p>
      )}
      {roster.paging.error && <MutationStatus error={roster.paging.error} notice={null} />}
      {actions.dialogs}
    </>
  );
}

interface RowProps {
  readonly tab: AgentRosterTab;
  readonly itemsFor: (row: AgentRosterRow) => RowMenuItem[];
  readonly withdrawElsewhere: WithdrawElsewhere;
  readonly busy: boolean;
}

function RosterTable({ rows, ...props }: RowProps & { readonly rows: readonly AgentRosterRow[] }) {
  const team = useTeamAccess().team;
  return (
    <Table caption={caption(props.tab, team.name)}>
      <TableHead>
        <TableRow>
          <TableHeader>Agent</TableHeader>
          <TableHeader>{props.tab === "personal" ? "Reach" : "Owner"}</TableHeader>
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
          <RosterRowView key={row.agentId} row={row} {...props} />
        ))}
      </TableBody>
    </Table>
  );
}

function RosterRowView({
  row,
  tab,
  itemsFor,
  withdrawElsewhere,
  busy,
}: RowProps & { readonly row: AgentRosterRow }) {
  const viewerId = useTeamAccess().user.id;
  const update = updateAvailableLabel(row);
  return (
    <TableRow data-agent={row.slug}>
      <TableRowHeader>
        <span className="inline-flex items-center gap-2">
          {row.icon && <AgentIconGlyph name={row.icon} />}
          {row.name}
          {row.dangerous && <DangerousBadge />}
        </span>
        {row.description && (
          <div className="text-sm font-normal text-console-muted">{row.description}</div>
        )}
      </TableRowHeader>
      <TableCell>
        {tab === "personal" ? (
          <ReachCell row={row} withdrawElsewhere={withdrawElsewhere} busy={busy} />
        ) : (
          ownerLabel(row)
        )}
      </TableCell>
      <TableCell>
        {versionInEffectLabel(row, viewerId)}
        {pinLabel(row) && <div className="text-sm text-console-muted">{pinLabel(row)}</div>}
      </TableCell>
      <TableCell>
        <span className="inline-flex flex-wrap items-center gap-1">
          <Badge tone={STATUS_TONE[row.status] ?? "neutral"}>{rosterStatusLabel(row, tab)}</Badge>
          {update && <Badge tone="running">{update}</Badge>}
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
  );
}

/** The Personal tab's Reach (AR2), with Withdraw for another team's roster (one left behind). */
function ReachCell({
  row,
  withdrawElsewhere,
  busy,
}: {
  readonly row: AgentRosterRow;
  readonly withdrawElsewhere: WithdrawElsewhere;
  readonly busy: boolean;
}) {
  const team = useTeamAccess().team;
  return (
    <ul className="m-0 list-none p-0">
      {reachItems(row, team).map(({ key, label, withdrawFrom }) => (
        <li key={key} className="flex flex-wrap items-center gap-2">
          {label}
          {withdrawFrom !== null && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={(e) =>
                void withdrawElsewhere(
                  row,
                  withdrawFrom.teamId,
                  withdrawFrom.teamName,
                  e.currentTarget,
                )
              }
            >
              Withdraw
              <span className="sr-only">{` ${row.name} (${label})`}</span>
            </Button>
          )}
        </li>
      ))}
    </ul>
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
  const kind = row.actions.edit ? "Edit" : row.actions.viewDefinition ? "View" : null;
  if (kind === null) return null;
  return (
    <Link href={kind === "Edit" ? editHref(row) : agentPageHref(row.agentId)}>
      {kind}
      <span className="sr-only"> {row.name}</span>
    </Link>
  );
}
