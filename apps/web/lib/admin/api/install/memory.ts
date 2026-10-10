/** Install console: memory switches (`/v1/memory/settings?level=install`; install.settings.manage; KOBE-155). */
import { apiRequest, type ApiResult } from "../../../api/client";
import type { MemorySwitches } from "../team/memory";

export const getInstallMemory = (): Promise<ApiResult<MemorySwitches>> =>
  apiRequest("/v1/memory/settings?level=install");

export const putInstallMemory = (
  change: Partial<MemorySwitches>,
): Promise<ApiResult<MemorySwitches>> =>
  apiRequest("/v1/memory/settings?level=install", {
    method: "PUT",
    json: {
      ...(change.memoryEnabled === undefined ? {} : { memory_enabled: change.memoryEnabled }),
      ...(change.projectMemoryEnabled === undefined
        ? {}
        : { project_memory_enabled: change.projectMemoryEnabled }),
    },
  });
