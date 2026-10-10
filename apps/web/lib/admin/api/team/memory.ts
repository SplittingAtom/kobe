/** Team console: memory switches (`/v1/memory/settings?level=team`; read: team.read, change: team.memory.manage; KOBE-155). */
import { apiRequest, type ApiResult } from "../../../api/client";

export interface MemorySwitches {
  readonly memoryEnabled: boolean;
  readonly projectMemoryEnabled: boolean;
}

export const getTeamMemory = (teamId: string): Promise<ApiResult<MemorySwitches>> =>
  apiRequest("/v1/memory/settings?level=team", { teamId });

export const putTeamMemory = (
  teamId: string,
  change: Partial<MemorySwitches>,
): Promise<ApiResult<MemorySwitches>> =>
  apiRequest("/v1/memory/settings?level=team", {
    method: "PUT",
    json: {
      ...(change.memoryEnabled === undefined ? {} : { memory_enabled: change.memoryEnabled }),
      ...(change.projectMemoryEnabled === undefined
        ? {}
        : { project_memory_enabled: change.projectMemoryEnabled }),
    },
    teamId,
  });
