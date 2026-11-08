"use client";

import type { AgentRosterRow, AgentRosterTab, AgentRosterTarget } from "@kobe/protocol";
import { useState, type ReactNode } from "react";
import { agentPageHref } from "../../lib/agents/redirects";
import { galleryExportHref, runGalleryEval } from "../../lib/admin/api/site/gallery";
import type { GalleryAgentSummary } from "../../lib/admin/api/site/gallery";
import {
  adoptRosterEntry,
  assignAgent,
  updateRosterEntry,
  withdrawAgent,
} from "../../lib/agents/roster-api";
import type { ApiResult } from "../../lib/api/client";
import { useConfirm, type Confirm, type RowMenuItem } from "../ui/console";
import { useNavigate } from "../shell/use-navigate";
import type { Mutation } from "../admin/use-resource";
import { downloadOrbitExport } from "../admin/team/agent-builder/orbit-export-button";
import { ApproveDialog, DeclineDialog, EvalDialog, PinDialog } from "./roster-dialogs";
import { ForkDialog } from "./fork-dialog";
import { canCompareWithSource, CompareWithSourceDialog } from "./lineage";

type Trigger = HTMLElement | null;
type DialogKind = "pin" | "decline" | "approve" | "eval" | "fork" | "compare";
type OpenDialog = (kind: DialogKind, row: AgentRosterRow, trigger: Trigger) => void;

/** What every flow needs: the team, the tab's roster, and the page's mutation and dialogs. */
interface Ctx {
  readonly teamId: string;
  readonly teamName: string;
  /** The roster the tab's admin actions act on: the Team tab's team roster, the Site tab's. */
  readonly roster: AgentRosterTarget;
  readonly rosterName: string;
  readonly mutation: Mutation;
  readonly confirm: Confirm;
  readonly navigate: (href: string) => void;
  readonly openDialog: OpenDialog;
  readonly onChanged: () => void;
  /** Site admins on the Site tab: the Gallery page's state per gallery agent (else null). */
  readonly gallery: ReadonlyMap<string, GalleryAgentSummary> | null;
}

const where = (ctx: Ctx, target: AgentRosterTarget) =>
  target === "site" ? "the site" : ctx.teamName;

async function change<T>(ctx: Ctx, call: () => Promise<ApiResult<T>>, notice: () => string) {
  if (await ctx.mutation.run(call, notice)) ctx.onChanged();
}

/** Asks first (danger tone), then runs the change. */
async function confirmed<T>(
  ctx: Ctx,
  trigger: Trigger,
  question: { title: string; description: string; confirmLabel: string },
  call: () => Promise<ApiResult<T>>,
  notice: () => string,
) {
  if (await ctx.confirm({ ...question, tone: "danger" }, trigger)) await change(ctx, call, notice);
}

/** Assigns (201: on the roster) or proposes (202: an admin decides) and says which. */
async function assign(ctx: Ctx, row: AgentRosterRow, target: AgentRosterTarget) {
  let status = 0;
  const admin = target === "site" ? "a site admin" : "a team admin";
  const roster = target === "site" ? "the site roster" : `${ctx.teamName}'s roster`;
  await change(
    ctx,
    async () => {
      const res = await assignAgent(ctx.teamId, row.agentId, target);
      if (res.ok) status = res.status;
      return res;
    },
    () =>
      status === 202
        ? `Proposed ${row.name} to ${where(ctx, target)}: ${admin} decides.`
        : `${row.name} is on ${roster}.`,
  );
}

/** The owner withdraws; `elsewhere` names another team's roster (one the owner may have left). */
function withdraw(
  ctx: Ctx,
  row: AgentRosterRow,
  target: AgentRosterTarget,
  trigger: Trigger,
  elsewhere?: { readonly teamId: string; readonly name: string },
) {
  const name = elsewhere?.name ?? where(ctx, target);
  return confirmed(
    ctx,
    trigger,
    {
      title: `Withdraw ${row.name} from ${name}?`,
      description:
        "Its threads keep the version they pinned; schedules that use it pause until it is back.",
      confirmLabel: "Withdraw",
    },
    () => withdrawAgent(ctx.teamId, row.agentId, target, elsewhere?.teamId),
    () => `Withdrew ${row.name} from ${name}.`,
  );
}

/** A roster admin's PUT on the tab's roster (or `roster`: suspension has its own). */
function put(
  ctx: Ctx,
  row: AgentRosterRow,
  body: Parameters<typeof updateRosterEntry>[3],
  notice: () => string,
  roster: AgentRosterTarget = ctx.roster,
) {
  return change(ctx, () => updateRosterEntry(ctx.teamId, roster, row.agentId, body), notice);
}

function suspend(ctx: Ctx, row: AgentRosterRow, siteWide: boolean, trigger: Trigger) {
  const scope = siteWide ? "every team" : ctx.teamName;
  return confirmed(
    ctx,
    trigger,
    {
      title: `Suspend ${row.name} for ${scope}?`,
      description: "It can't start new runs there until it is resumed.",
      confirmLabel: "Suspend",
    },
    () =>
      updateRosterEntry(ctx.teamId, siteWide ? "site" : "team", row.agentId, {
        state: "suspended",
      }),
    () => `Suspended ${row.name} for ${scope}.`,
  );
}

/** A menu entry, offered when `when` (the row's action flag) holds. */
interface ItemSpec extends Omit<RowMenuItem, "disabled"> {
  readonly when: boolean;
}

/** Assign or propose, and withdraw: the owner's reach (AR6, AR7). */
function reachItems(ctx: Ctx, row: AgentRosterRow): ItemSpec[] {
  const a = row.actions;
  const team = ctx.teamName;
  return [
    {
      when: a.assignTeam !== null,
      id: a.assignTeam === "direct" ? "assign-team" : "propose-team",
      label: a.assignTeam === "direct" ? `Assign to ${team}` : `Propose to ${team}`,
      onSelect: () => void assign(ctx, row, "team"),
    },
    {
      when: a.assignSite !== null,
      id: a.assignSite === "direct" ? "assign-site" : "propose-site",
      label: a.assignSite === "direct" ? "Assign to the site" : "Propose to the site",
      onSelect: () => void assign(ctx, row, "site"),
    },
    {
      when: a.withdrawTeam,
      id: "withdraw-team",
      label: `Withdraw from ${team}`,
      destructive: true,
      onSelect: (t) => void withdraw(ctx, row, "team", t),
    },
    {
      when: a.withdrawSite,
      id: "withdraw-site",
      label: "Withdraw from the site",
      destructive: true,
      onSelect: (t) => void withdraw(ctx, row, "site", t),
    },
  ];
}

/** Approve or decline a proposal (§6.4); Update to latest and Pin (AR5). */
function decisionItems(ctx: Ctx, row: AgentRosterRow): ItemSpec[] {
  const a = row.actions;
  const latest = row.currentVersion;
  return [
    {
      when: a.decide,
      id: "approve",
      label: "Approve…",
      onSelect: (t) => ctx.openDialog("approve", row, t),
    },
    {
      when: a.decide,
      id: "decline",
      label: "Decline…",
      destructive: true,
      onSelect: (t) => ctx.openDialog("decline", row, t),
    },
    {
      when: a.pin && row.updateAvailable && latest !== null,
      id: "update",
      label: `Update to latest (v${latest ?? ""})`,
      onSelect: () =>
        void put(
          ctx,
          row,
          { state: "active", versionRule: "latest" },
          () =>
            `${row.name} now follows its latest version (v${latest ?? ""}) on ${ctx.rosterName}.`,
        ),
    },
    {
      when: a.pin,
      id: "pin",
      label: "Pin a version…",
      onSelect: (t) => ctx.openDialog("pin", row, t),
    },
  ];
}

/** Hands a same-origin file (a gallery agent's definition) to the browser as a download. */
function download(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
}

/**
 * The Inventory's Export to Orbit (team admins, readable published agents) and the Gallery
 * page's Run eval and Export (site admins, gallery rows), KOBE-570 AR12.
 */
function consoleItems(ctx: Ctx, row: AgentRosterRow): ItemSpec[] {
  const version = row.currentVersion;
  const gallery = row.kind === "gallery" ? ctx.gallery?.get(row.agentId) : undefined;
  return [
    {
      when: row.usage?.canExport === true && version !== null,
      id: "export-orbit",
      label: "Export to Orbit",
      onSelect: () => {
        if (version !== null) {
          void ctx.mutation.run(() =>
            downloadOrbitExport(ctx.teamId, row.agentId, row.slug, version),
          );
        }
      },
    },
    {
      when: gallery !== undefined && version !== null,
      id: "run-eval",
      label: "Run eval…",
      onSelect: (t) => ctx.openDialog("eval", row, t),
    },
    {
      when: gallery !== undefined,
      id: "export-file",
      label: "Export file",
      onSelect: () => download(galleryExportHref(row.agentId), `${row.slug}.md`),
    },
  ];
}

/** Adopt an Unavailable entry into the roster's ownership (AR10, KOBE-568). */
function adopt(ctx: Ctx, row: AgentRosterRow, trigger: Trigger) {
  const owner = ctx.roster === "site" ? "the site" : ctx.teamName;
  return confirmed(
    ctx,
    trigger,
    {
      title: `Adopt ${row.name} into ${owner}?`,
      description: `Its published version becomes ${ctx.roster === "site" ? "a gallery agent" : "a team agent"} that ${owner} owns and edits; this entry leaves the roster.`,
      confirmLabel: "Adopt",
    },
    () => adoptRosterEntry(ctx.teamId, ctx.roster, row.agentId),
    () => `Adopted ${row.name}: ${owner} now owns a copy.`,
  );
}

/** Suspend and resume (§6.5), adopt (AR10), remove (AR7), fork (AR8) and compare (§7.5). */
function lifecycleItems(ctx: Ctx, row: AgentRosterRow): ItemSpec[] {
  const a = row.actions;
  const resume = (siteWide: boolean) =>
    void put(
      ctx,
      row,
      { state: "active" },
      () => `Resumed ${row.name} for ${siteWide ? "every team" : ctx.teamName}.`,
      siteWide ? "site" : "team",
    );
  const remove = (t: Trigger) =>
    void confirmed(
      ctx,
      t,
      {
        title: `Remove ${row.name} from ${ctx.rosterName}?`,
        description: "Members can no longer start it here; its threads keep their pinned version.",
        confirmLabel: "Remove",
      },
      () => updateRosterEntry(ctx.teamId, ctx.roster, row.agentId, { state: "removed" }),
      () => `Removed ${row.name} from ${ctx.rosterName}.`,
    );
  return [
    {
      when: a.suspendHere,
      id: "suspend-here",
      label: "Suspend here",
      destructive: true,
      onSelect: (t) => void suspend(ctx, row, false, t),
    },
    { when: a.resumeHere, id: "resume-here", label: "Resume here", onSelect: () => resume(false) },
    {
      when: a.suspendSiteWide,
      id: "suspend-site",
      label: "Suspend site-wide",
      destructive: true,
      onSelect: (t) => void suspend(ctx, row, true, t),
    },
    {
      when: a.resumeSiteWide,
      id: "resume-site",
      label: "Resume site-wide",
      onSelect: () => resume(true),
    },
    {
      // The server offers Adopt on assigned entries to the roster's admins (KOBE-571).
      when: a.adopt,
      id: "adopt",
      label: `Adopt into ${ctx.rosterName}`,
      onSelect: (t) => void adopt(ctx, row, t),
    },
    {
      when: a.remove,
      id: "remove",
      label: `Remove from ${ctx.rosterName}`,
      destructive: true,
      onSelect: remove,
    },
    {
      when: a.fork,
      id: "fork",
      label: "Fork to Personal…",
      onSelect: (t) => ctx.openDialog("fork", row, t),
    },
    {
      when: canCompareWithSource(row),
      id: "compare-source",
      label: "Compare with source",
      onSelect: (t) => ctx.openDialog("compare", row, t),
    },
  ];
}

/** The row's ⋯ menu, from the row's `actions` only (the server's §5 decisions). */
export function rosterMenuItems(ctx: Ctx, row: AgentRosterRow): RowMenuItem[] {
  return [
    ...reachItems(ctx, row),
    ...decisionItems(ctx, row),
    ...consoleItems(ctx, row),
    ...lifecycleItems(ctx, row),
  ]
    .filter((spec) => spec.when)
    .map(({ when: _when, ...item }) => ({ ...item, disabled: ctx.mutation.pending }));
}

type Dialog = {
  readonly kind: DialogKind;
  readonly row: AgentRosterRow;
  readonly trigger: Trigger;
} | null;

/** Approve, Pin, Decline, Run eval, Fork and Compare dialogs for the row that opened them. */
function RosterDialogs({
  ctx,
  dialog,
  onClose,
}: {
  readonly ctx: Ctx;
  readonly dialog: Dialog;
  readonly onClose: () => void;
}) {
  if (dialog === null) return null;
  const { row, trigger } = dialog;
  const common = {
    teamId: ctx.teamId,
    row,
    rosterName: ctx.rosterName,
    returnFocus: trigger,
    pending: ctx.mutation.pending,
    onClose,
  };
  if (dialog.kind === "fork") {
    return (
      <ForkDialog
        row={row}
        team={{ id: ctx.teamId, name: ctx.teamName }}
        returnFocus={trigger}
        onClose={onClose}
        onForked={(id) => {
          onClose();
          ctx.navigate(agentPageHref(id));
        }}
      />
    );
  }
  if (dialog.kind === "compare") {
    return (
      <CompareWithSourceDialog
        row={row}
        teamId={ctx.teamId}
        returnFocus={trigger}
        onClose={onClose}
      />
    );
  }
  if (dialog.kind === "eval") {
    return (
      <EvalDialog
        row={row}
        activeTeamId={ctx.teamId}
        returnFocus={trigger}
        pending={ctx.mutation.pending}
        onClose={onClose}
        onRun={async (team) => {
          onClose();
          await ctx.mutation.run(
            () => runGalleryEval(row.agentId, team.id),
            () =>
              `Evaluating ${row.name} in ${team.name}. The score appears here when it finishes.`,
          );
        }}
      />
    );
  }
  if (dialog.kind === "approve") {
    return (
      <ApproveDialog
        {...common}
        onApprove={async (versionRule) => {
          onClose();
          await put(
            ctx,
            row,
            versionRule === "latest" ? { state: "active" } : { state: "active", versionRule },
            () =>
              versionRule === "latest"
                ? `Approved ${row.name} for ${ctx.rosterName}.`
                : `Approved ${row.name} for ${ctx.rosterName}, pinned to v${versionRule}.`,
          );
        }}
      />
    );
  }
  return dialog.kind === "pin" ? (
    <PinDialog
      {...common}
      onPin={async (versionRule) => {
        onClose();
        await put(ctx, row, { state: "active", versionRule }, () =>
          versionRule === "latest"
            ? `${row.name} follows its latest version on ${ctx.rosterName}.`
            : `Pinned ${row.name} to v${versionRule} on ${ctx.rosterName}.`,
        );
      }}
    />
  ) : (
    <DeclineDialog
      {...common}
      onDecline={async (note) => {
        onClose();
        await put(
          ctx,
          row,
          { state: "removed", ...(note === "" ? {} : { note }) },
          () => `Declined ${row.name} for ${ctx.rosterName}.`,
        );
      }}
    />
  );
}

/**
 * The row actions of the Agents page (KOBE-569, spec agents-roster AR5–AR7, §6.4, §6.5): each
 * item is offered only when the row's `actions` say so, calls its AR16 route and, on success,
 * refreshes the tab. Errors show the server's message (422 agent_bound_to_team, 409 caps, 429)
 * through the shared mutation.
 */
export function useRosterActions(props: {
  readonly teamId: string;
  readonly teamName: string;
  readonly tab: AgentRosterTab;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
  readonly gallery: ReadonlyMap<string, GalleryAgentSummary> | null;
}): {
  readonly itemsFor: (row: AgentRosterRow) => RowMenuItem[];
  /** Withdraws from another team's roster (Reach column): one the owner may have left. */
  readonly withdrawElsewhere: (
    row: AgentRosterRow,
    fromTeamId: string,
    teamLabel: string,
    trigger: Trigger,
  ) => Promise<void>;
  readonly dialogs: ReactNode;
} {
  const [confirm, confirmDialog] = useConfirm();
  const [dialog, setDialog] = useState<Dialog>(null);
  const navigate = useNavigate();
  const roster: AgentRosterTarget = props.tab === "site" ? "site" : "team";
  const ctx: Ctx = {
    ...props,
    roster,
    rosterName: roster === "site" ? "the site" : props.teamName,
    confirm,
    navigate,
    openDialog: (kind, row, trigger) => setDialog({ kind, row, trigger }),
  };
  return {
    itemsFor: (row) => rosterMenuItems(ctx, row),
    withdrawElsewhere: (row, teamId, name, trigger) =>
      withdraw(ctx, row, "team", trigger, { teamId, name }),
    dialogs: (
      <>
        {confirmDialog}
        <RosterDialogs ctx={ctx} dialog={dialog} onClose={() => setDialog(null)} />
      </>
    ),
  };
}
