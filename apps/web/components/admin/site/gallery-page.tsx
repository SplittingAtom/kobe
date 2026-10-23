"use client";

import Link from "next/link";
import { agentStatusLabel } from "../../../lib/admin/api/agents";
import {
  galleryExportHref,
  listGalleryAgents,
  listGalleryScores,
  listMyTeamsForEval,
  runGalleryEval,
} from "../../../lib/admin/api/site/gallery";
import { MutationStatus } from "../error-notice";
import { GalleryScoreCell } from "../gallery-score";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { CustomizedBadge, UpdateAvailable } from "./gallery-customization";
import { useState } from "react";
import {
  Button,
  EmptyState,
  Field,
  PageHeader,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../ui/console";

/**
 * Gallery agents (spec D19/D21; `/v1/site/gallery/agents`): they come from the definitions in the
 * repository, seeded at install and upgrade (KOBE-87). Site admins edit them in the agent creator
 * (KOBE-494, D19/D21 amended 2026-10-23): an edit marks the agent Customized and detaches it from
 * the repository; a newer repository version can then be compared and reset to. Teams fork them.
 */
export function GalleryPage() {
  const { state, reload } = useResource(listGalleryAgents);
  const scores = useResource(listGalleryScores);
  const teams = useResource(listMyTeamsForEval).state;
  const mutation = useMutation();
  const [teamId, setTeamId] = useState("");
  const myTeams = teams.status === "ready" ? teams.data.teams : [];
  const hostTeam = teamId || myTeams[0]?.id || "";

  return (
    <>
      <PageHeader
        title="Gallery agents"
        description="Gallery agents are available to every team, read-only there; teams fork them to change them. They come from the definitions shipped with Kobe and update with each release, unless a site admin edits one: it is then Customized and releases leave it as edited until it is reset to the repository. A team can suspend a gallery agent for itself in its agent inventory."
      />
      <p className="text-sm text-console-muted">
        Orbit scores are published for every team to see. An eval runs in a team you belong to (its
        sandbox runtime and model budget) and takes several minutes; reload to see the score.
      </p>
      {myTeams.length > 0 && (
        <Field label="Run evals in team" className="my-4 w-fit">
          <Select value={hostTeam} onChange={(e) => setTeamId(e.target.value)}>
            {myTeams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="gallery agents">
        {(agents) =>
          agents.length === 0 ? (
            <EmptyState title="The gallery is empty." />
          ) : (
            <>
              {agents.map((a) => (
                <UpdateAvailable
                  key={a.id}
                  agentId={a.id}
                  name={a.name}
                  gallery={a.gallery}
                  onReset={reload}
                />
              ))}
              <Table caption="Gallery">
                <TableHead>
                  <TableRow>
                    <TableHeader>Agent</TableHeader>
                    <TableHeader>Slug</TableHeader>
                    <TableHeader>Status</TableHeader>
                    <TableHeader>Version</TableHeader>
                    <TableHeader>Orbit score</TableHeader>
                    <TableHeader>Updated</TableHeader>
                    <TableHeader>
                      <span className="sr-only">Actions</span>
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {agents.map((a) => (
                    <TableRow key={a.id}>
                      <TableRowHeader>
                        {a.name} <CustomizedBadge gallery={a.gallery} />
                        {a.description && (
                          <div className="text-sm font-normal text-console-muted">
                            {a.description}
                          </div>
                        )}
                      </TableRowHeader>
                      <TableCell>
                        <code>{a.slug}</code>
                      </TableCell>
                      <TableCell>{agentStatusLabel(a)}</TableCell>
                      <TableCell>
                        {a.currentVersion === null ? "Draft" : `v${a.currentVersion}`}
                      </TableCell>
                      <TableCell>
                        <GalleryScoreCell agentId={a.id} state={scores.state} />
                      </TableCell>
                      <TableCell>
                        <DateTime value={a.updatedAt} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          {a.canEdit && !a.archivedAt && (
                            <Button size="sm" asChild>
                              <Link href={`/admin/site/gallery/${encodeURIComponent(a.id)}`}>
                                Edit<span className="sr-only"> {a.name}</span>
                              </Link>
                            </Button>
                          )}
                          {a.currentVersion !== null && hostTeam !== "" && (
                            <Button
                              size="sm"
                              disabled={mutation.pending}
                              onClick={() =>
                                void mutation.run(
                                  () => runGalleryEval(a.id, hostTeam),
                                  () =>
                                    `Evaluating ${a.name}. The score appears here when it finishes.`,
                                )
                              }
                            >
                              Run eval<span className="sr-only"> for {a.name}</span>
                            </Button>
                          )}
                          <Button size="sm" asChild>
                            <a href={galleryExportHref(a.id)} download={`${a.slug}.md`}>
                              Export<span className="sr-only"> {a.name}</span>
                            </a>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )
        }
      </ResourceView>
    </>
  );
}
