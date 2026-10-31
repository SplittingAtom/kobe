import { apiRequest, type ApiResult } from "../api/client";
import { TEAM_HEADER } from "../teams";
import type { AppPlacement } from "./app-cards";

/**
 * A thread's MCP App results as this viewer sees them (KOBE-438, spec MA10, T12): the server
 * decides whether each one opens as the live app (the viewer acting as themselves) or stays a text
 * card, and why. The list is read like the markers; a stored result is read raw (never camelized:
 * it is the upstream's data and the app reads its keys).
 */
export type AppTextReason = "too_large" | "template_changed" | "not_app_visible" | "no_access";

export interface AppResultView {
  readonly resultRef: string;
  readonly runId: string | null;
  readonly userEntryId: string | null;
  readonly toolCallId: string | null;
  readonly entryId: string | null;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly tool: string;
  readonly appId: string;
  readonly templateSha256: string;
  readonly view: "app" | "text";
  /** A rail-launched card waiting for the thread's run to end (KOBE-440); absent = false. */
  readonly queued?: boolean;
  readonly reason?: AppTextReason;
  /** `placement` (KOBE-531): where a site admin set the app to open; absent means `chat`. */
  readonly app?: { readonly title: string; readonly placement?: AppPlacement };
}

export interface AppResultList {
  readonly results: readonly AppResultView[];
  readonly truncated: boolean;
}

/** The text card's one line (spec MA10). */
export function textReason(view: Pick<AppResultView, "reason" | "connectorName">): string {
  switch (view.reason) {
    case "too_large":
      return "This app's data was too large to keep, so it shows as text.";
    case "template_changed":
      return "This app changed and is waiting for review.";
    case "not_app_visible":
      return "This tool is no longer offered to apps.";
    case "no_access":
      return `Connect ${view.connectorName} to use this app.`;
    default:
      return "This app shows as text.";
  }
}

export function listAppResults(
  threadId: string,
  teamId: string,
  fetchFn?: typeof fetch,
): Promise<ApiResult<AppResultList>> {
  return apiRequest<AppResultList>(`/v1/threads/${encodeURIComponent(threadId)}/app-results`, {
    teamId,
    ...(fetchFn ? { fetchFn } : {}),
  });
}

export type StoredResult =
  | {
      readonly ok: true;
      /** The input the upstream ran (review LOW-2): the app's tool-input, never Pi's entry. */
      readonly input: Record<string, unknown> | null;
      readonly result: Record<string, unknown>;
    }
  | { readonly ok: false; readonly code: string };

export async function readAppResult(
  threadId: string,
  ref: string,
  teamId: string,
  fetchFn: typeof fetch = fetch,
): Promise<StoredResult> {
  const path = `/v1/threads/${encodeURIComponent(threadId)}/app-results/${encodeURIComponent(ref)}`;
  let res: Response;
  try {
    res = await fetchFn(path, {
      headers: { accept: "application/json", [TEAM_HEADER]: teamId },
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, code: "network_error" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, code: "unavailable" };
  }
  const result = (body as { result?: unknown } | null)?.result;
  const input = (body as { input?: unknown } | null)?.input;
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (res.ok && isObject(result)) {
    return { ok: true, input: isObject(input) ? input : null, result };
  }
  const code = (body as { code?: unknown } | null)?.code;
  return { ok: false, code: typeof code === "string" ? code.slice(0, 64) : "unavailable" };
}
