import { AGENT_MEMORY_SETTINGS, type AgentMemorySetting } from "@kobe/protocol";
import { useState } from "react";
import {
  getAgentVersion,
  setTeamAgentMemory,
  type PublishedAgent,
} from "../../../../lib/admin/api/team/agent-builder";
import { Button, ChoiceGroup, Radio, Section } from "../../../ui/console";
import { ErrorNotice } from "../../error-notice";
import { ResourceView } from "../../parts";
import { useMutation, useResource } from "../../use-resource";

/** What each setting means, in the editor and the version history (KOBE-646). */
export const MEMORY_SETTING_LABELS: Readonly<
  Record<AgentMemorySetting, { readonly label: string; readonly hint: string }>
> = {
  all: {
    label: "All memory",
    hint: "Memory notes (My memory, project memory) and any other memories Kobe keeps.",
  },
  notes_only: {
    label: "Notes only",
    hint: "Memory notes only.",
  },
  off: {
    label: "Off",
    hint: "No memory at all: no memory index, no remember or recall tools.",
  },
};

/**
 * The agent's memory setting (KOBE-646, Chris Q3): part of each published version, so a change
 * publishes the current version again as a new one with the new setting (threads and pinned
 * rosters keep their version; rosters that follow the latest version get it). Runs always use the
 * memory of the person running the agent, never its owner's.
 */
export function MemorySetting({
  teamId,
  agentId,
  currentVersion,
  canChange,
  busy,
  onChanged,
}: {
  readonly teamId: string;
  readonly agentId: string;
  readonly currentVersion: number | null;
  readonly canChange: boolean;
  /** Another change to the agent is running: no second one meanwhile. */
  readonly busy: boolean;
  readonly onChanged: (result: PublishedAgent, memory: AgentMemorySetting) => void;
}) {
  return (
    <Section
      id="memory-setting-title"
      title="Memory"
      description="Runs use the memory of the person running the agent, never yours. A change publishes a new version."
    >
      {currentVersion === null ? (
        <p className="m-0 text-sm text-console-muted">
          Publish the agent to choose its memory. New agents use all memory.
        </p>
      ) : (
        <CurrentSetting
          key={currentVersion}
          teamId={teamId}
          agentId={agentId}
          version={currentVersion}
          canChange={canChange}
          busy={busy}
          onChanged={onChanged}
        />
      )}
    </Section>
  );
}

function CurrentSetting({
  teamId,
  agentId,
  version,
  canChange,
  busy,
  onChanged,
}: {
  readonly teamId: string;
  readonly agentId: string;
  readonly version: number;
  readonly canChange: boolean;
  readonly busy: boolean;
  readonly onChanged: (result: PublishedAgent, memory: AgentMemorySetting) => void;
}) {
  const { state } = useResource(() => getAgentVersion(teamId, agentId, version));
  return (
    <ResourceView state={state} label="memory setting">
      {(data) => (
        <SettingForm
          agentId={agentId}
          teamId={teamId}
          current={data.version.memory ?? "all"}
          canChange={canChange}
          busy={busy}
          onChanged={onChanged}
        />
      )}
    </ResourceView>
  );
}

function SettingForm({
  teamId,
  agentId,
  current,
  canChange,
  busy,
  onChanged,
}: {
  readonly teamId: string;
  readonly agentId: string;
  readonly current: AgentMemorySetting;
  readonly canChange: boolean;
  readonly busy: boolean;
  readonly onChanged: (result: PublishedAgent, memory: AgentMemorySetting) => void;
}) {
  const [picked, setPicked] = useState<AgentMemorySetting>(current);
  const save = useMutation();
  return (
    <>
      <ChoiceGroup legend="Memory for this agent" stacked>
        {AGENT_MEMORY_SETTINGS.map((setting) => (
          <Radio
            key={setting}
            name={`memory-${agentId}`}
            value={setting}
            checked={picked === setting}
            disabled={!canChange || save.pending}
            onChange={() => setPicked(setting)}
            label={MEMORY_SETTING_LABELS[setting].label}
            hint={MEMORY_SETTING_LABELS[setting].hint}
          />
        ))}
      </ChoiceGroup>
      {save.error && <ErrorNotice error={save.error} />}
      {canChange && (
        <Button
          className="mt-3"
          disabled={picked === current || busy}
          loading={save.pending}
          onClick={() =>
            void save.run(async () => {
              const res = await setTeamAgentMemory(teamId, agentId, picked);
              if (res.ok) onChanged(res.data, picked);
              return res;
            })
          }
        >
          Save as a new version
        </Button>
      )}
    </>
  );
}
