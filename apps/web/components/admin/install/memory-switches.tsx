"use client";

import { getInstallMemory, putInstallMemory } from "../../../lib/admin/api/install/memory";
import { ResourceView } from "../parts";
import { useResource } from "../use-resource";
import { MemorySwitchesForm } from "../team/memory-switches-form";

/**
 * Install-wide memory switches (`/v1/memory/settings?level=install`, KOBE-155). A team's memory is
 * on only while both this and the team's own switch are on.
 */
export function MemorySwitchesSection() {
  const { state, reload } = useResource(getInstallMemory);
  return (
    <ResourceView state={state} label="memory settings">
      {(switches) => (
        <MemorySwitchesForm
          where="on this install"
          switches={switches}
          save={putInstallMemory}
          onSaved={reload}
          saveLabel="Save memory settings"
        />
      )}
    </ResourceView>
  );
}
