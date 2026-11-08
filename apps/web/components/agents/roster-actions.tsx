"use client";

import type { AgentRosterRow, AgentRosterTab, AgentRosterTarget } from "@kobe/protocol";
import { useState, type ReactNode } from "react";
import { agentPageHref } from "../../lib/agents/redirects";
import {
  assignAgent,
  forkToPersonal,
  updateRosterEntry,
  withdrawAgent,
} from "../../lib/agents/roster-api";
import type { ApiResult } from "../../lib/api/client";
import { useConfirm, type RowMenuItem } from "../ui/console";
import { useNavigate } from "../shell/use-navigate";
import type { Mutation } from "../admin/use-resource";
import { DeclineDialog, PinDialog } from "./roster-dialogs";

/** The roster a tab's admin actions act on: the Team tab's team roster, the Site tab's site one. */
const rosterOf = (tab: AgentRosterTab): AgentRosterTarget => (tab === "site" ? "site" : "team");

type Dialog =
  | { readonly kind: "pin"; readonly row: AgentRosterRow; readonly trigger: HTMLElement | null }
  | { readonly kind: "decline"; readonly row: AgentRosterRow; readonly trigger: HTMLElement | null }
  | null;

/**
 * The row actions of the Agents page (KOBE-569, spec agents-roster AR6, AR7, AR5, §6.4, §6.5):
 * each item is offered only when the row's `actions` say so, calls its AR16 route and, on
 * success, refreshes the tab. Errors show the server's message (422 agent_bound_to_team, 409
 * caps, 429) through the shared mutation.
 */
export function useRosterActions({
  teamId,
  teamName,
  tab,
  mutation,
  onChanged,
}: {
  readonly teamId: string;
  readonly teamName: string;
  readonly tab: AgentRosterTab;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}): {
  readonly itemsFor: (row: AgentRosterRow) => RowMenuItem[];
  /** Withdraws from another team's roster (Reach column): one the owner may have left. */
  readonly withdrawElsewhere: (
    row: AgentRosterRow,
    fromTeamId: string,
    teamLabel: string,
    trigger: HTMLElement | null,
  ) => Promise<void>;
  readonly dialogs: ReactNode;
} {
  const [confirm, confirmDialog] = useConfirm();
  const [dialog, setDialog] = useState<Dialog>(null);
  const navigate = useNavigate();
  const roster = rosterOf(tab);
  const rosterName = roster === "site" ? "the site" : teamName;

  async function change<T>(call: () => Promise<ApiResult<T>>, notice: (data: T) => string) {
    if (await mutation.run(call, notice)) onChanged();
  }

  async function assign(row: AgentRosterRow, target: AgentRosterTarget) {
    const where = target === "site" ? "the site" : teamName;
    let status = 0;
    await change(
      async () => {
        const res = await assignAgent(teamId, row.agentId, target);
        if (res.ok) status = res.status;
        return res;
      },
      () =>
        status === 202
          ? `Proposed ${row.name} to ${where}: ${target === "site" ? "a site admin" : "a team admin"} decides.`
          : `${row.name} is on ${target === "site" ? "the site roster" : `${teamName}'s roster`}.`,
    );
  }

  async function withdraw(
    row: AgentRosterRow,
    target: AgentRosterTarget,
    trigger: HTMLElement | null,
    elsewhere?: { readonly teamId: string; readonly name: string },
  ) {
    const where = elsewhere?.name ?? (target === "site" ? "the site" : teamName);
    const ok = await confirm(
      {
        title: `Withdraw ${row.name} from ${where}?`,
        description:
          "Its threads keep the version they pinned; schedules that use it pause until it is back.",
        confirmLabel: "Withdraw",
        tone: "danger",
      },
      trigger,
    );
    if (!ok) return;
    await change(
      () => withdrawAgent(teamId, row.agentId, target, elsewhere?.teamId),
      () => `Withdrew ${row.name} from ${where}.`,
    );
  }

  async function remove(row: AgentRosterRow, trigger: HTMLElement | null) {
    const ok = await confirm(
      {
        title: `Remove ${row.name} from ${rosterName}?`,
        description: "Members can no longer start it here; its threads keep their pinned version.",
        confirmLabel: "Remove",
        tone: "danger",
      },
      trigger,
    );
    if (!ok) return;
    await change(
      () => updateRosterEntry(teamId, roster, row.agentId, { state: "removed" }),
      () => `Removed ${row.name} from ${rosterName}.`,
    );
  }

  async function suspend(row: AgentRosterRow, siteWide: boolean, trigger: HTMLElement | null) {
    const where = siteWide ? "every team" : teamName;
    const ok = await confirm(
      {
        title: `Suspend ${row.name} for ${where}?`,
        description: "It can't start new runs there until it is resumed.",
        confirmLabel: "Suspend",
        tone: "danger",
      },
      trigger,
    );
    if (!ok) return;
    await change(
      () =>
        updateRosterEntry(teamId, siteWide ? "site" : "team", row.agentId, { state: "suspended" }),
      () => `Suspended ${row.name} for ${where}.`,
    );
  }

  function resume(row: AgentRosterRow, siteWide: boolean) {
    return change(
      () => updateRosterEntry(teamId, siteWide ? "site" : "team", row.agentId, { state: "active" }),
      () => `Resumed ${row.name} for ${siteWide ? "every team" : teamName}.`,
    );
  }

  async function fork(row: AgentRosterRow) {
    let newId: string | null = null;
    const done = await mutation.run(
      async () => {
        const res = await forkToPersonal(teamId, row.agentId);
        if (res.ok) newId = res.data.agent.id;
        return res;
      },
      () => `Forked ${row.name} into your personal agents.`,
    );
    if (done && newId !== null) navigate(agentPageHref(newId));
  }

  function itemsFor(row: AgentRosterRow): RowMenuItem[] {
    const a = row.actions;
    const busy = mutation.pending;
    const items: RowMenuItem[] = [];
    const add = (item: Omit<RowMenuItem, "disabled">) => items.push({ ...item, disabled: busy });
    if (a.assignTeam) {
      add({
        id: a.assignTeam === "direct" ? "assign-team" : "propose-team",
        label: a.assignTeam === "direct" ? `Assign to ${teamName}` : `Propose to ${teamName}`,
        onSelect: () => void assign(row, "team"),
      });
    }
    if (a.assignSite) {
      add({
        id: a.assignSite === "direct" ? "assign-site" : "propose-site",
        label: a.assignSite === "direct" ? "Assign to the site" : "Propose to the site",
        onSelect: () => void assign(row, "site"),
      });
    }
    if (a.withdrawTeam) {
      add({
        id: "withdraw-team",
        label: `Withdraw from ${teamName}`,
        destructive: true,
        onSelect: (t) => void withdraw(row, "team", t),
      });
    }
    if (a.withdrawSite) {
      add({
        id: "withdraw-site",
        label: "Withdraw from the site",
        destructive: true,
        onSelect: (t) => void withdraw(row, "site", t),
      });
    }
    if (a.decide) {
      add({
        id: "approve",
        label: "Approve",
        onSelect: () =>
          void change(
            () => updateRosterEntry(teamId, roster, row.agentId, { state: "active" }),
            () => `Approved ${row.name} for ${rosterName}.`,
          ),
      });
      add({
        id: "decline",
        label: "Decline…",
        destructive: true,
        onSelect: (trigger) => setDialog({ kind: "decline", row, trigger }),
      });
    }
    if (a.pin && row.updateAvailable && row.currentVersion !== null) {
      const latest = row.currentVersion;
      add({
        id: "update",
        label: `Update to latest (v${latest})`,
        onSelect: () =>
          void change(
            () =>
              updateRosterEntry(teamId, roster, row.agentId, {
                state: "active",
                versionRule: "latest",
              }),
            () => `${row.name} now follows its latest version (v${latest}) on ${rosterName}.`,
          ),
      });
    }
    if (a.pin) {
      add({
        id: "pin",
        label: "Pin a version…",
        onSelect: (trigger) => setDialog({ kind: "pin", row, trigger }),
      });
    }
    if (a.suspendHere) {
      add({
        id: "suspend-here",
        label: "Suspend here",
        destructive: true,
        onSelect: (t) => void suspend(row, false, t),
      });
    }
    if (a.resumeHere) {
      add({ id: "resume-here", label: "Resume here", onSelect: () => void resume(row, false) });
    }
    if (a.suspendSiteWide) {
      add({
        id: "suspend-site",
        label: "Suspend site-wide",
        destructive: true,
        onSelect: (t) => void suspend(row, true, t),
      });
    }
    if (a.resumeSiteWide) {
      add({ id: "resume-site", label: "Resume site-wide", onSelect: () => void resume(row, true) });
    }
    if (a.remove) {
      add({
        id: "remove",
        label: `Remove from ${rosterName}`,
        destructive: true,
        onSelect: (t) => void remove(row, t),
      });
    }
    if (a.fork) {
      add({ id: "fork", label: "Fork to Personal", onSelect: () => void fork(row) });
    }
    return items;
  }

  const close = () => setDialog(null);
  const dialogs = (
    <>
      {confirmDialog}
      {dialog?.kind === "pin" && (
        <PinDialog
          row={dialog.row}
          rosterName={rosterName}
          returnFocus={dialog.trigger}
          pending={mutation.pending}
          onClose={close}
          onPin={async (versionRule) => {
            close();
            await change(
              () =>
                updateRosterEntry(teamId, roster, dialog.row.agentId, {
                  state: "active",
                  versionRule,
                }),
              () =>
                versionRule === "latest"
                  ? `${dialog.row.name} follows its latest version on ${rosterName}.`
                  : `Pinned ${dialog.row.name} to v${versionRule} on ${rosterName}.`,
            );
          }}
        />
      )}
      {dialog?.kind === "decline" && (
        <DeclineDialog
          row={dialog.row}
          rosterName={rosterName}
          returnFocus={dialog.trigger}
          pending={mutation.pending}
          onClose={close}
          onDecline={async (note) => {
            close();
            await change(
              () =>
                updateRosterEntry(teamId, roster, dialog.row.agentId, {
                  state: "removed",
                  ...(note === "" ? {} : { note }),
                }),
              () => `Declined ${dialog.row.name} for ${rosterName}.`,
            );
          }}
        />
      )}
    </>
  );

  const withdrawElsewhere = (
    row: AgentRosterRow,
    fromTeamId: string,
    teamLabel: string,
    trigger: HTMLElement | null,
  ) => withdraw(row, "team", trigger, { teamId: fromTeamId, name: teamLabel });

  return { itemsFor, withdrawElsewhere, dialogs };
}
