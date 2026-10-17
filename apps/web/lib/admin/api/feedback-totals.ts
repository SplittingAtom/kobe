/**
 * An agent's answer-feedback totals (KOBE-275, `GET /v1/agents/{id}/feedback?window=7|30|90`),
 * camelized from `@kobe/protocol` feedback.ts. Counts only: no member, comment, conversation or
 * run is in the answer. Every number stands on `minRaters` other raters; a total below it is
 * `enough: false`, and a breakdown with any cell below it is null ("not enough to break down").
 */
import {
  FEEDBACK_DEFAULT_WINDOW_DAYS,
  FEEDBACK_REASONS,
  FEEDBACK_WINDOWS_DAYS,
  type FeedbackReason,
  type FeedbackWindowDays,
} from "@kobe/protocol";
import { apiRequest, type ApiResult } from "../../api/client";
import { toCamel } from "../../api/casing";

export { FEEDBACK_DEFAULT_WINDOW_DAYS, FEEDBACK_WINDOWS_DAYS, type FeedbackWindowDays };

const enc = encodeURIComponent;

export interface ShownCounts {
  readonly up: number;
  readonly down: number;
  /** up / (up + down); null when nothing was rated. */
  readonly rate: number | null;
}

export type ReasonCounts = Readonly<Record<FeedbackReason, number>>;

export interface VersionTotals extends ShownCounts {
  /** The published version that answered; null = unknown (after compaction). */
  readonly version: number | null;
  readonly reasons: ReasonCounts | null;
  readonly models: readonly (ShownCounts & { readonly model: string | null })[] | null;
}

export interface AgentFeedbackTotals {
  readonly agentId: string;
  readonly from: string;
  readonly to: string;
  readonly windowDays: FeedbackWindowDays;
  readonly minRaters: number;
  readonly totals: {
    readonly enough: boolean;
    readonly up: number | null;
    readonly down: number | null;
    readonly rate: number | null;
  };
  readonly versions: readonly VersionTotals[] | null;
  readonly series:
    readonly { readonly start: string; readonly up: number; readonly down: number }[] | null;
}

type WireVersion = Omit<VersionTotals, "reasons"> & {
  readonly reasons: Readonly<Record<string, number>> | null;
};
type Wire = Omit<AgentFeedbackTotals, "versions"> & {
  readonly versions: readonly WireVersion[] | null;
};

/** The reason counts arrive with camelized keys (`tooSlow`): back to the contract's codes. */
function reasonCounts(raw: Readonly<Record<string, number>> | null): ReasonCounts | null {
  if (raw === null) return null;
  return Object.fromEntries(FEEDBACK_REASONS.map((r) => [r, raw[toCamel(r)] ?? 0])) as Record<
    FeedbackReason,
    number
  >;
}

export async function getAgentFeedbackTotals(
  teamId: string,
  agentId: string,
  windowDays: FeedbackWindowDays,
): Promise<ApiResult<AgentFeedbackTotals>> {
  const res = await apiRequest<Wire>(`/v1/agents/${enc(agentId)}/feedback?window=${windowDays}`, {
    teamId,
  });
  if (!res.ok) return res;
  const versions =
    res.data.versions?.map((v) => ({ ...v, reasons: reasonCounts(v.reasons) })) ?? null;
  return { ...res, data: { ...res.data, versions } };
}
