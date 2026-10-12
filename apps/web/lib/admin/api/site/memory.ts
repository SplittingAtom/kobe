/** Site console: memory switches (`/v1/memory/settings?level=site`; site.settings.manage; KOBE-155). */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { MemorySwitches } from "../team/memory";

export const getSiteMemory = (): Promise<ApiResult<MemorySwitches>> =>
  apiRequest("/v1/memory/settings?level=site");

export const putSiteMemory = (
  change: Partial<MemorySwitches>,
): Promise<ApiResult<MemorySwitches>> =>
  apiRequest("/v1/memory/settings?level=site", {
    method: "PUT",
    json: {
      ...(change.memoryEnabled === undefined ? {} : { memory_enabled: change.memoryEnabled }),
      ...(change.projectMemoryEnabled === undefined
        ? {}
        : { project_memory_enabled: change.projectMemoryEnabled }),
    },
  });
