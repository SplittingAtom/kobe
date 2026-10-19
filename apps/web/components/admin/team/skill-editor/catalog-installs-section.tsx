"use client";

import {
  listTeamSkillInstalls,
  reinstallDefault,
  uninstallCatalogSkill,
  type CatalogInstall,
  type RemovedDefault,
} from "../../../../lib/admin/api/team/skill-installs";
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
  useConfirm,
} from "../../../ui/console";
import { getCatalogSwitches } from "../../../../lib/admin/api/team/skill-review";
import { useTeamAccess } from "../../console-context";
import { InstallUpdatesPanel } from "./install-updates";
import { SkillInstallChangeForm } from "./skill-install-change";
import { MutationStatus } from "../../error-notice";
import { DateTime, ResourceView } from "../../parts";
import { useMutation, useResource } from "../../use-resource";

const ACCESS: Record<CatalogInstall["access"], string> = {
  available: "Available",
  default_on: "On by default",
  required: "Required",
  hidden: "Hidden",
};
const PIN: Record<CatalogInstall["pinMode"], string> = {
  pinned: "Pinned",
  within_major: "Track within major",
  latest: "Track latest",
};

/**
 * The team's catalog installs and its Removed defaults (KOBE-314, SK6, SK7). Team admins change
 * an install (version, pin mode, access; KOBE-316), uninstall (a Site default is then kept out of
 * the team until reinstalled) and reinstall; Builders change installs while the team allows it.
 */
export function CatalogInstallsSection() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const canManage = access.permissions.includes("team.skills.installs.manage");
  // Builders change installs while the team allows it (KOBE-316, SK25): never Required or the
  // Site default's own installs (the server also refuses those a Team admin made).
  const isBuilder = !canManage && access.permissions.includes("team.skills.publish");
  const switches = useResource(() =>
    isBuilder
      ? getCatalogSwitches(teamId)
      : Promise.resolve({ ok: true as const, data: null, status: 200 }),
  );
  const builderMay =
    isBuilder &&
    switches.state.status === "ready" &&
    switches.state.data?.buildersMayInstallCatalog === true;
  const mayChange = (i: CatalogInstall) =>
    canManage || (builderMay && i.access !== "required" && i.origin !== "default_tag");
  const { state, reload } = useResource(() => listTeamSkillInstalls(teamId));
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();

  async function uninstall(install: CatalogInstall, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Uninstall ${install.name}?`,
        description: install.isDefault
          ? "It is a Site default: the team keeps it out, also when the Site syncs defaults again, until you reinstall it under Removed defaults."
          : "Members stop getting it from their next run.",
        confirmLabel: "Uninstall",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => uninstallCatalogSkill(teamId, install.skillId),
      (r) =>
        r.optedOut
          ? `Uninstalled ${install.name}; it is listed under Removed defaults.`
          : `Uninstalled ${install.name}.`,
    );
    if (done) reload();
  }

  async function reinstall(removed: RemovedDefault) {
    const done = await mutation.run(
      () => reinstallDefault(teamId, removed.skillId),
      (r) => `Reinstalled ${removed.name} at ${r.semver}.`,
    );
    if (done) reload();
  }

  return (
    <Section id="catalog-installs" title="Catalog skills in this team">
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="catalog installs">
        {(data) => (
          <>
            {data.installs.length === 0 ? (
              <EmptyState title="No catalog skills are installed." />
            ) : (
              <Table caption="Catalog installs" hideCaption>
                <TableHead>
                  <TableRow>
                    <TableHeader>Skill</TableHeader>
                    <TableHeader>Version</TableHeader>
                    <TableHeader>Access</TableHeader>
                    <TableHeader>Updated</TableHeader>
                    {(canManage || builderMay) && (
                      <TableHeader>
                        <span className="sr-only">Actions</span>
                      </TableHeader>
                    )}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.installs.map((i) => (
                    <TableRow key={i.skillId}>
                      <TableRowHeader>
                        {i.name}{" "}
                        {i.origin === "default_tag" ? (
                          <Badge tone="accent">Added by Site default</Badge>
                        ) : i.isDefault ? (
                          <Badge tone="accent">Site default</Badge>
                        ) : null}
                      </TableRowHeader>
                      <TableCell>
                        {i.semver}
                        <div className="text-sm text-console-muted">{PIN[i.pinMode]}</div>
                      </TableCell>
                      <TableCell>{ACCESS[i.access]}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <DateTime value={i.updatedAt} />
                      </TableCell>
                      {(canManage || builderMay) && (
                        <TableCell>
                          {mayChange(i) && (
                            <SkillInstallChangeForm
                              teamId={teamId}
                              install={i}
                              mayRequire={canManage}
                              pending={mutation.pending}
                              run={async (action, notice) => {
                                const done = await mutation.run(action, notice);
                                if (done) reload();
                                return done;
                              }}
                            />
                          )}
                          <InstallUpdatesPanel
                            teamId={teamId}
                            install={i}
                            mayMove={mayChange(i)}
                            pending={mutation.pending}
                            run={async (action, notice) => {
                              const done = await mutation.run(action, notice);
                              if (done) reload();
                              return done;
                            }}
                          />
                          {canManage && (
                            <Button
                              variant="danger"
                              disabled={mutation.pending}
                              aria-label={`Uninstall ${i.name}`}
                              onClick={(e) => void uninstall(i, eventTrigger(e))}
                            >
                              Uninstall
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {data.removedDefaults.length > 0 && (
              <Table caption="Removed defaults">
                <TableHead>
                  <TableRow>
                    <TableHeader>Skill</TableHeader>
                    <TableHeader>Reason</TableHeader>
                    <TableHeader>Removed</TableHeader>
                    {(canManage || builderMay) && (
                      <TableHeader>
                        <span className="sr-only">Actions</span>
                      </TableHeader>
                    )}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.removedDefaults.map((r) => (
                    <TableRow key={r.skillId}>
                      <TableRowHeader>{r.name}</TableRowHeader>
                      <TableCell>{r.reason ?? "None given"}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <DateTime value={r.at} />
                      </TableCell>
                      {canManage && (
                        <TableCell>
                          <Button
                            disabled={mutation.pending}
                            aria-label={`Reinstall ${r.name}`}
                            onClick={() => void reinstall(r)}
                          >
                            Reinstall
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </ResourceView>
      {confirmDialog}
    </Section>
  );
}
