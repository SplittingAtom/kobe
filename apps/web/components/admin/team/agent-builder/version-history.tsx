import Link from "next/link";
import { useState } from "react";
import type { AgentMemorySetting } from "@kobe/protocol";
import {
  listTeamAgentVersions,
  type AgentVersionSummary,
} from "../../../../lib/admin/api/team/agent-builder";
import { percent } from "../../../../lib/admin/orbit-score";
import {
  Badge,
  Button,
  EmptyState,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  eventTrigger,
} from "../../../ui/console";
import { DateTime, ResourceView } from "../../parts";
import { useMutation, useResource } from "../../use-resource";
import { ErrorNotice } from "../../error-notice";
import { MEMORY_SETTING_LABELS } from "./memory-setting";
import { OrbitExportButton } from "./orbit-export-button";

/** A restore that changes the memory setting: the current version's, and the restored one's. */
export interface MemoryChange {
  readonly from: AgentMemorySetting;
  readonly to: AgentMemorySetting;
}

const memoryOf = (v: AgentVersionSummary | undefined): AgentMemorySetting => v?.memory ?? "all";

/**
 * A memory change (KOBE-646) republishes a version with only its memory setting changed; a
 * restore copies the version's setting too. So a republished version whose setting differs from
 * its source's (both on the page) is a memory change, read from the stored rows.
 */
function memoryChangedFrom(
  v: AgentVersionSummary,
  versions: readonly AgentVersionSummary[],
): AgentVersionSummary | undefined {
  if (v.republishedFrom === null) return undefined;
  const source = versions.find((s) => s.version === v.republishedFrom);
  return source && memoryOf(source) !== memoryOf(v) ? source : undefined;
}

/** Published versions, newest first; restoring one republishes it as the newest (D19). */
export function VersionHistory({
  teamId,
  agentId,
  agentSlug,
  currentVersion,
  canExport,
  canRestore,
  restoring,
  onRestore,
}: {
  readonly teamId: string;
  readonly agentId: string;
  readonly agentSlug: string;
  readonly currentVersion: number | null;
  readonly canExport: boolean;
  readonly canRestore: boolean;
  readonly restoring: boolean;
  /** `memory`: set when restoring changes the memory setting (KOBE-646): from now, to restored. */
  readonly onRestore: (version: number, trigger: HTMLElement | null, memory?: MemoryChange) => void;
}) {
  const { state } = useResource(() => listTeamAgentVersions(teamId, agentId));
  const more = useMutation();
  const [older, setOlder] = useState<readonly AgentVersionSummary[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);

  return (
    <Section id="history-title" title="Version history">
      <ResourceView state={state} label="versions">
        {(page) => {
          const versions = [...page.versions, ...older];
          const nextBefore = cursor === undefined ? page.nextBefore : cursor;
          if (versions.length === 0) return <EmptyState title="Nothing is published yet." />;
          return (
            <>
              <Table caption="Published versions" hideCaption>
                <TableHead>
                  <TableRow>
                    <TableHeader>Version</TableHeader>
                    <TableHeader>Published</TableHeader>
                    <TableHeader>Safety score</TableHeader>
                    <TableHeader>
                      <span className="sr-only">Actions</span>
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow key={v.version}>
                      <TableRowHeader>
                        v{v.version}
                        {v.version === currentVersion && (
                          <>
                            {" "}
                            <Badge tone="running">Current</Badge>
                          </>
                        )}
                        {v.republishedFrom !== null && (
                          <div className="text-sm font-normal text-console-muted">
                            {memoryChangedFrom(v, versions)
                              ? `Memory changed from v${v.republishedFrom}`
                              : `Restored from v${v.republishedFrom}`}
                          </div>
                        )}
                        {v.memory !== undefined && v.memory !== "all" && (
                          <div className="text-sm font-normal text-console-muted">
                            Memory: {MEMORY_SETTING_LABELS[v.memory].label}
                          </div>
                        )}
                      </TableRowHeader>
                      <TableCell>
                        <DateTime value={v.publishedAt} />
                      </TableCell>
                      <TableCell>
                        {v.score ? (
                          <>
                            {`${percent(v.score.attackSuccessRate)} attacks succeeded (limit ${percent(v.score.threshold)})`}{" "}
                            <Link
                              href={`/admin/team/agents/${encodeURIComponent(agentId)}/evals/${encodeURIComponent(v.score.evalId)}`}
                            >
                              Report
                              <span className="sr-only"> for version {v.version}</span>
                            </Link>
                          </>
                        ) : (
                          "Not evaluated"
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          {canExport && (
                            <OrbitExportButton
                              teamId={teamId}
                              agentId={agentId}
                              agentSlug={agentSlug}
                              version={v.version}
                              label={`Export version ${v.version} to Orbit`}
                              size="sm"
                            />
                          )}
                          {canRestore && v.version !== currentVersion && (
                            <Button
                              size="sm"
                              disabled={restoring}
                              onClick={(e) => {
                                const now = memoryOf(
                                  versions.find((c) => c.version === currentVersion),
                                );
                                const to = memoryOf(v);
                                onRestore(
                                  v.version,
                                  eventTrigger(e),
                                  now === to ? undefined : { from: now, to },
                                );
                              }}
                            >
                              {`Restore version ${v.version}`}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {more.error && <ErrorNotice error={more.error} />}
              {nextBefore !== null && (
                <Button
                  className="mt-3"
                  loading={more.pending}
                  onClick={() =>
                    void more.run(async () => {
                      const res = await listTeamAgentVersions(teamId, agentId, nextBefore);
                      if (res.ok) {
                        setOlder((prev) => [...prev, ...res.data.versions]);
                        setCursor(res.data.nextBefore);
                      }
                      return res;
                    })
                  }
                >
                  Load older versions
                </Button>
              )}
            </>
          );
        }}
      </ResourceView>
    </Section>
  );
}
