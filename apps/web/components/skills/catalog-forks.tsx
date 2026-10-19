"use client";

import { getSkillChoices } from "../../lib/admin/api/team/skill-choices";
import { forkToDraft } from "../../lib/skills/drafts-api";
import { Button, Section } from "../ui/console";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { ResourceView } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
import { draftHref } from "./draft-href";

/**
 * Catalog skills the team has installed, to fork into a draft of your own (KOBE-322): Kobe's
 * names are reserved, so the copy starts under `<name>-custom` (renamed in the editor at will).
 */
export function CatalogForks() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const { state } = useResource(() => getSkillChoices(teamId));
  const mutation = useMutation();
  if (!access.permissions.includes("team.personal.create")) return null;
  return (
    <Section
      title="Catalog skills in this team"
      level={2}
      description="Fork one to make your own version of it in the Workbench."
    >
      <ResourceView state={state} label="catalog skills">
        {(choices) =>
          choices.catalog.length === 0 ? (
            <p className="m-0 text-sm text-console-muted">The team has no catalog skills.</p>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0">
              {choices.catalog.map((c) => (
                <li key={c.skillId} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  <Button
                    size="sm"
                    disabled={mutation.pending}
                    aria-label={`Fork ${c.name} into the Workbench`}
                    onClick={() =>
                      void mutation.run(async () => {
                        const res = await forkToDraft(
                          teamId,
                          { kind: "catalog", skillId: c.skillId },
                          c.name.length <= 57 ? `${c.name}-custom` : c.name,
                        );
                        if (res.ok) window.location.assign(draftHref(res.data.id));
                        return res;
                      })
                    }
                  >
                    Fork
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>
      <MutationStatus error={mutation.error} notice={null} />
    </Section>
  );
}
