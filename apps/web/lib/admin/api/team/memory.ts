/**
 * Workspace settings › Memory (`/v1/memory/settings?level=team`; read: team.read, change:
 * team.memory.manage; KOBE-155, widened by KOBE-381): the Workspace's memory switches and its
 * learning model, and (`level=effective`) what applies to the Workspace now.
 */
import { apiRequest, type ApiResult } from "../../../api/client";

/** The two D24 switches every level has (the Notes switches; `memoryEnabled` is the master). */
export interface MemorySwitches {
  readonly memoryEnabled: boolean;
  readonly projectMemoryEnabled: boolean;
}

export interface WorkspaceMemorySettings extends MemorySwitches {
  readonly memoriesEnabled: boolean;
  readonly workspaceMemoriesEnabled: boolean;
  readonly siteMemoriesEnabled: boolean;
  readonly learnEnabled: boolean;
  readonly siteProposalsEnabled: boolean;
  /** The Workspace's learning model alias; null = none. */
  readonly learningModelAlias: string | null;
}

export interface EffectiveMemory {
  readonly memoryEnabled: boolean;
  readonly projectMemoryEnabled: boolean;
  readonly memoriesEnabled: boolean;
  readonly scopes: {
    readonly user: boolean;
    readonly portable: boolean;
    readonly team: boolean;
    readonly site: boolean;
  };
  readonly policy: boolean;
  readonly siteProposalsEnabled: boolean;
  readonly learn:
    | { readonly available: true; readonly alias: string; readonly source: "site" | "team" }
    | { readonly available: false; readonly reason: string; readonly message: string };
}

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** A camelCase change as the route's snake_case body; absent keys stay absent. */
export function snakeBody(change: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(change)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [snake(k), v]),
  );
}

export const getTeamMemory = (teamId: string): Promise<ApiResult<WorkspaceMemorySettings>> =>
  apiRequest("/v1/memory/settings?level=team", { teamId });

export const getEffectiveMemory = (teamId: string): Promise<ApiResult<EffectiveMemory>> =>
  apiRequest("/v1/memory/settings?level=effective", { teamId });

export const putTeamMemory = (
  teamId: string,
  change: Partial<WorkspaceMemorySettings>,
): Promise<ApiResult<WorkspaceMemorySettings>> =>
  apiRequest("/v1/memory/settings?level=team", {
    method: "PUT",
    json: snakeBody(change),
    teamId,
  });
