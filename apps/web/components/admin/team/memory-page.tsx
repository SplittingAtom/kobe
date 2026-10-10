"use client";

import { useTeamAccess } from "../console-context";
import { getTeamMemory, putTeamMemory } from "../../../lib/admin/api/team/memory";
import { ResourceView } from "../parts";
import { useResource } from "../use-resource";
import { MemorySwitchesForm } from "./memory-switches-form";

/**
 * Team memory switches (`/v1/memory/settings?level=team`, KOBE-155): all memory, and project
 * memory. Effective only while the install allows it too; turning a switch off removes
 * `remember`/`recall` and the memory index from the team's next runs.
 */
export function TeamMemoryPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => getTeamMemory(teamId));
  return (
    <>
      <h1>Memory</h1>
      <ResourceView state={state} label="memory settings">
        {(switches) => (
          <MemorySwitchesForm
            where="for this team"
            switches={switches}
            save={(change) => putTeamMemory(teamId, change)}
            onSaved={reload}
          />
        )}
      </ResourceView>
    </>
  );
}
