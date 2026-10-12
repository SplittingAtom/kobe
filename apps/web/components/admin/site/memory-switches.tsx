"use client";

import { getSiteMemory, putSiteMemory } from "../../../lib/admin/api/site/memory";
import { ResourceView } from "../parts";
import { useResource } from "../use-resource";
import { MemorySwitchesForm } from "../team/memory-switches-form";

/**
 * Site-wide memory switches (`/v1/memory/settings?level=site`, KOBE-155). A team's memory is
 * on only while both this and the team's own switch are on.
 */
export function MemorySwitchesSection() {
  const { state, reload } = useResource(getSiteMemory);
  return (
    <ResourceView state={state} label="memory settings">
      {(switches) => (
        <MemorySwitchesForm
          where="on this site"
          switches={switches}
          save={putSiteMemory}
          onSaved={reload}
          saveLabel="Save memory settings"
        />
      )}
    </ResourceView>
  );
}
