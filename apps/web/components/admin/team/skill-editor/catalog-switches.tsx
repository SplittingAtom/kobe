"use client";

import {
  getCatalogSwitches,
  putCatalogSwitches,
  type CatalogSwitches,
} from "../../../../lib/admin/api/team/skill-review";
import { Checkbox, Section } from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { MutationStatus } from "../../error-notice";
import { ResourceView } from "../../parts";
import { useMutation, useResource } from "../../use-resource";

const HINT = "m-0 my-1 text-sm text-console-muted";

/**
 * The team's catalog switches (KOBE-316, SK25), both on by default: members' own adds of catalog
 * skills, and Builders' installs (never Required, never a deprecated version). Team admins change
 * them; everyone else sees them.
 */
export function CatalogSwitchesSection() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const isAdmin = access.permissions.includes("team.skills.review");
  const { state, reload } = useResource(() => getCatalogSwitches(teamId));
  const mutation = useMutation();
  const change = async (patch: Partial<CatalogSwitches>, notice: string) => {
    const done = await mutation.run(
      () => putCatalogSwitches(teamId, patch),
      () => notice,
    );
    if (done) reload();
  };
  return (
    <Section id="catalog-switches-heading" title="Catalog settings">
      <ResourceView state={state} label="the catalog settings">
        {(s) => (
          <>
            <Checkbox
              label="Members may add catalog skills for themselves"
              hint="A member's add loads only in their own runs in this team."
              checked={s.membersMayAddCatalog}
              disabled={!isAdmin || mutation.pending}
              onChange={(e) =>
                change(
                  { membersMayAddCatalog: e.target.checked },
                  e.target.checked ? "Members may add catalog skills." : "Member adds are off.",
                )
              }
            />
            <Checkbox
              label="Builders may install catalog skills"
              hint="Builders never install a version as Required, and never a deprecated one."
              checked={s.buildersMayInstallCatalog}
              disabled={!isAdmin || mutation.pending}
              onChange={(e) =>
                change(
                  { buildersMayInstallCatalog: e.target.checked },
                  e.target.checked
                    ? "Builders may install catalog skills."
                    : "Only team admins install catalog skills.",
                )
              }
            />
            <Checkbox
              label="Builders may promote without confirmation"
              hint="Off: a Builder's Promote to Site waits for a team admin, who sees what leaves the team."
              checked={s.buildersMayPromote}
              disabled={!isAdmin || mutation.pending}
              onChange={(e) =>
                change(
                  { buildersMayPromote: e.target.checked },
                  e.target.checked
                    ? "Builders promote to the Site without confirmation."
                    : "Builders' promotions wait for a team admin.",
                )
              }
            />
            {!isAdmin && <p className={HINT}>Only team admins can change these.</p>}
            <MutationStatus error={mutation.error} notice={mutation.notice} />
          </>
        )}
      </ResourceView>
    </Section>
  );
}
