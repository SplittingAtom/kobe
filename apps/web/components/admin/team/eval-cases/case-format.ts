import type { EvalCaseStatus } from "../../../../lib/admin/api/eval-cases";
import type { BadgeTone } from "../../../ui/console";

export type AgentScope = "team" | "personal";

/** The agent's page: the Team console's builder for team agents, My agents for personal ones. */
export function agentHref(scope: AgentScope, agentId: string): string {
  const base = scope === "team" ? "/admin/team/agents" : "/me/agents";
  return `${base}/${encodeURIComponent(agentId)}`;
}

export const casesHref = (scope: AgentScope, agentId: string): string =>
  `${agentHref(scope, agentId)}/cases`;

export const caseHref = (scope: AgentScope, agentId: string, caseId: string): string =>
  `${casesHref(scope, agentId)}/${encodeURIComponent(caseId)}`;

/**
 * A UTC day (`YYYY-MM-DD`) in the viewer's locale, as a date only: shared cases carry the day,
 * never the time, so nothing here can be read as when in the day a case came in.
 */
export function formatDay(day: string): string {
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
}

export const STATUS_LABEL: Readonly<Record<EvalCaseStatus, string>> = {
  open: "Waiting for review",
  accepted: "Accepted",
  dismissed: "Dismissed",
};

export const STATUS_TONE: Readonly<Record<EvalCaseStatus, BadgeTone>> = {
  open: "attention",
  accepted: "running",
  dismissed: "neutral",
};

export const versionLabel = (version: number | null): string =>
  version === null ? "Unknown version" : `v${version}`;
