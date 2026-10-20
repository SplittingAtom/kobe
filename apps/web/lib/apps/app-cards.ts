import { apiRequest, type ApiResult } from "../api/client";
import type { AppLaunchDraft } from "../chat/session";

/**
 * MCP Apps in the rail (KOBE-440, spec MA3, MA8, MA11): the member's apps, the ones a key of their
 * own would add ("Add your key"), and rail launches. A launch calls the app's opening tool on the
 * server as the member and inserts an **app card** into the thread (no run, no model call), or,
 * during a run, queues it until the run ends.
 */
export interface RailApp {
  readonly appId: string;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly tool: string;
  readonly title: string;
  /** The approved template's hash (the frame route serves only these bytes). */
  readonly sha256: string;
}

/**
 * A picker app (KOBE-460, spec MA3 as amended 2026-10-20): its display name contains "Picker",
 * in any case. One may run live in the rail's Apps tab.
 */
export function isPicker(app: Pick<RailApp, "title">): boolean {
  return /picker/i.test(app.title);
}

export interface MissingKeyApp {
  readonly connectorId: string;
  readonly connectorName: string;
  readonly title: string;
}

export interface RailApps {
  readonly apps: readonly RailApp[];
  readonly needsKey: readonly MissingKeyApp[];
}

/** Where a member adds their own connector keys (KOBE-105). */
export const MY_CONNECTOR_KEYS = "/me/connectors";

export type LaunchResult =
  | { readonly threadId: string; readonly resultRef: string; readonly queued: true }
  | {
      readonly threadId: string;
      readonly resultRef: string;
      readonly entryId: string;
      readonly queued: false;
    };

export function listRailApps(teamId: string, fetchFn?: typeof fetch): Promise<ApiResult<RailApps>> {
  return apiRequest<RailApps>("/v1/team/apps", { teamId, ...(fetchFn ? { fetchFn } : {}) });
}

/**
 * Launches `appId` into `threadId`, or into a new thread (titled after the app) when null; a new
 * thread starts with `draft`, the new-conversation view's agent and connectors off (KOBE-458).
 */
export function launchAppCard(
  threadId: string | null,
  appId: string,
  teamId: string,
  fetchFn?: typeof fetch,
  draft?: AppLaunchDraft,
): Promise<ApiResult<LaunchResult>> {
  const path =
    threadId === null
      ? "/v1/threads/app-cards"
      : `/v1/threads/${encodeURIComponent(threadId)}/app-cards`;
  return apiRequest<LaunchResult>(path, {
    method: "POST",
    json: {
      app_id: appId,
      ...(threadId !== null || draft?.agentId === undefined ? {} : { agent_id: draft.agentId }),
      ...(threadId !== null || !draft || draft.connectorsOff.length === 0
        ? {}
        : { connectors_off: draft.connectorsOff }),
    },
    teamId,
    ...(fetchFn ? { fetchFn } : {}),
  });
}

/** Removes a card that waits for the thread's run (the chip's ×). */
export function removeQueuedAppCard(
  threadId: string,
  resultRef: string,
  teamId: string,
  fetchFn?: typeof fetch,
): Promise<ApiResult<unknown>> {
  return apiRequest<unknown>(
    `/v1/threads/${encodeURIComponent(threadId)}/app-cards/${encodeURIComponent(resultRef)}`,
    { method: "DELETE", teamId, ...(fetchFn ? { fetchFn } : {}) },
  );
}

/**
 * Tells the thread on screen that its cards changed (a launch, a removal): it reads its entries
 * and app results again. Keyed by thread id.
 */
export class AppCardSignal {
  #listeners = new Map<string, Set<() => void>>();

  listen(threadId: string, listener: () => void): () => void {
    const set = this.#listeners.get(threadId) ?? new Set();
    set.add(listener);
    this.#listeners.set(threadId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(threadId);
    };
  }

  changed(threadId: string): void {
    for (const listener of [...(this.#listeners.get(threadId) ?? [])]) listener();
  }
}
