"use client";

import { useState } from "react";
import { listSkills, type SkillScope } from "../../lib/admin/api/team/skills";
import { forkToDraft } from "../../lib/skills/drafts-api";
import { exportSkillVersion } from "../../lib/admin/api/team/skills";

/** Hands the browser a downloaded file (KOBE-345 exports). */
function saveFile(bytes: Uint8Array, name: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
import { MutationStatus } from "../admin/error-notice";
import { useMutation } from "../admin/use-resource";
import { draftHref } from "./draft-href";
import { PromotePanel } from "./promote-panel";
import {
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../ui/console";
import { useTeamAccess } from "../admin/console-context";
import { DateTime, ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import { useNavigate } from "../shell/use-navigate";

const TITLES: Readonly<Record<SkillScope, string>> = {
  team: "Team skills",
  personal: "My personal skills",
};

const EMPTY: Readonly<Record<SkillScope, string>> = {
  team: "The team has no skills yet. Write one in the Workbench and save it to the team.",
  personal: "You have no personal skills yet. Write one in the Workbench and save it as yours.",
};

/**
 * The team's skills, or the caller's personal ones, with their latest version (KOBE-321). "Edit
 * in Workbench" forks the latest version under the skill's own name (KOBE-322): saving the draft
 * makes the skill's next version.
 */
export function SkillList({ scope }: { readonly scope: SkillScope }) {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const canEdit = access.permissions.includes("team.personal.create");
  // Team skills: Builders and Team admins; personal skills: their author (KOBE-333, SK19).
  const canPromote =
    scope === "personal" ? canEdit : access.permissions.includes("team.skills.publish");
  const [promoting, setPromoting] = useState<string | null>(null);
  const { state } = useResource(() => listSkills(teamId, scope));
  const mutation = useMutation();
  const navigate = useNavigate();
  const download = (
    s: { id: string; slug: string; latestVersion: number; latestSemver: string },
    evals: boolean,
  ) =>
    mutation.run(async () => {
      const res = await exportSkillVersion(teamId, s.id, s.latestVersion, evals);
      if (res.ok) saveFile(res.data, `${s.slug}-v${s.latestSemver}${evals ? "-evals" : ""}.zip`);
      return res;
    });
  const edit = (skillId: string) =>
    mutation.run(async () => {
      const res = await forkToDraft(teamId, { kind: scope, skillId });
      if (res.ok) navigate(draftHref(res.data.id));
      return res;
    });
  return (
    <>
      <MutationStatus error={mutation.error} notice={null} />
      <ResourceView state={state} label={TITLES[scope].toLowerCase()}>
        {(skills) =>
          skills.length === 0 ? (
            <EmptyState title={EMPTY[scope]} />
          ) : (
            <Table caption={TITLES[scope]}>
              <TableHead>
                <TableRow>
                  <TableHeader>Skill</TableHeader>
                  <TableHeader>Latest version</TableHeader>
                  <TableHeader>Updated</TableHeader>
                  {canEdit && <TableHeader>Actions</TableHeader>}
                </TableRow>
              </TableHead>
              <TableBody>
                {skills.map((s) => (
                  <TableRow key={s.id}>
                    <TableRowHeader>
                      {s.slug}
                      <div className="text-sm font-normal text-console-muted">{s.description}</div>
                      {promoting === s.id && (
                        <PromotePanel
                          teamId={teamId}
                          source={{ scope, skillId: s.id, version: s.latestVersion }}
                          onDone={() => setPromoting(null)}
                        />
                      )}
                    </TableRowHeader>
                    <TableCell>v{s.latestSemver}</TableCell>
                    <TableCell>
                      <DateTime value={s.updatedAt} compact />
                    </TableCell>
                    {canEdit && (
                      <TableCell>
                        <Button
                          size="sm"
                          disabled={mutation.pending}
                          aria-label={`Edit ${s.slug} in the Workbench`}
                          onClick={() => void edit(s.id)}
                        >
                          Edit in Workbench
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={mutation.pending}
                          aria-label={`Download ${s.slug} v${s.latestSemver}`}
                          onClick={() => void download(s, false)}
                        >
                          Download
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={mutation.pending}
                          aria-label={`Download ${s.slug} v${s.latestSemver} with evals`}
                          onClick={() => void download(s, true)}
                        >
                          Download with evals
                        </Button>
                        {canPromote && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-expanded={promoting === s.id}
                            aria-label={`Promote ${s.slug} v${s.latestSemver} to the Site`}
                            onClick={() => setPromoting(promoting === s.id ? null : s.id)}
                          >
                            Promote to Site
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </ResourceView>
    </>
  );
}
