/**
 * The proposals queue of a roster (KOBE-570, spec agents-roster §6.4): a proposal is a row in
 * status `proposed`; the queue holds those the viewer may decide (the roster's admins).
 */
import type { AgentRosterRow } from "@kobe/protocol";

const waiting = (row: AgentRosterRow) => row.status === "proposed" && row.actions.decide;

/** How many proposals wait for the viewer's decision among the loaded rows. */
export function proposalCount(rows: readonly AgentRosterRow[]): number {
  return rows.filter(waiting).length;
}

/** The rows the tab shows: all, or only the proposals waiting for a decision. */
export function shownRows(
  rows: readonly AgentRosterRow[],
  onlyProposals: boolean,
): readonly AgentRosterRow[] {
  return onlyProposals ? rows.filter(waiting) : rows;
}
