"use client";

import { useState, type FormEvent } from "react";
import { putTeamSkillInstall } from "../../lib/admin/api/team/skill-installs";
import type { CatalogDetail } from "../../lib/skills/catalog-api";
import { Button, Field, FormRow, Notice, Section, Select } from "../ui/console";
import type { Mutation } from "../admin/use-resource";
import { skillInstallNotice } from "../admin/team/skill-editor/skill-install-change";

const PIN = { pinned: "Pinned", within_major: "Track within major", latest: "Track latest" };
const ACCESS = {
  available: "Available (members turn it on)",
  default_on: "On by default (members may turn it off)",
  required: "Required (always loaded)",
  hidden: "Hidden (only agents that name it)",
};

/**
 * Install a catalog skill in this team (KOBE-337, SK25): a version (approved, or deprecated with a
 * warning; never withdrawn or revoked), a pin mode and an access mode. Team admins, and Builders
 * while the team allows it (never Required); the server checks every rule again.
 */
export function CatalogInstall({
  detail,
  teamId,
  mayRequire,
  mutation,
  onDone,
}: {
  readonly detail: CatalogDetail;
  readonly teamId: string;
  readonly mayRequire: boolean;
  readonly mutation: Mutation;
  readonly onDone: () => void;
}) {
  const installable = detail.versions.filter(
    (v) => v.state === "approved" || v.state === "deprecated",
  );
  const current = detail.state.installed;
  const [version, setVersion] = useState(current?.semver ?? installable[0]?.semver ?? "");
  const [pinMode, setPinMode] = useState<keyof typeof PIN>(
    (current?.pinMode as keyof typeof PIN | undefined) ?? "within_major",
  );
  const [access, setAccess] = useState<keyof typeof ACCESS>(
    (current?.access as keyof typeof ACCESS | undefined) ?? "available",
  );
  const deprecated = installable.find((v) => v.semver === version)?.state === "deprecated";
  if (detail.state.blocked)
    return (
      <Section title="Install in this team">
        <p>A Team admin blocked this skill in the team.</p>
      </Section>
    );
  if (installable.length === 0) return null;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const done = await mutation.run(
      () => putTeamSkillInstall(teamId, detail.id, { version, pinMode, access }),
      (r) => skillInstallNotice(detail.name, r),
    );
    if (done) onDone();
  };
  return (
    <Section
      title={current ? "This team's install" : "Install in this team"}
      description="A version change reaches the next run of every thread."
    >
      <form onSubmit={(e) => void submit(e)} aria-label="Install in this team">
        <FormRow>
          <Field label="Version">
            <Select value={version} onChange={(e) => setVersion(e.target.value)}>
              {installable.map((v) => (
                <option key={v.id} value={v.semver}>
                  {v.semver}
                  {v.state === "deprecated" ? " (deprecated)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pin">
            <Select
              value={pinMode}
              onChange={(e) => setPinMode(e.target.value as keyof typeof PIN)}
            >
              {Object.entries(PIN).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Access">
            <Select
              value={access}
              onChange={(e) => setAccess(e.target.value as keyof typeof ACCESS)}
            >
              {Object.entries(ACCESS)
                .filter(([k]) => mayRequire || k !== "required")
                .map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" disabled={mutation.pending}>
            {current ? "Save" : "Install skill"}
          </Button>
        </FormRow>
      </form>
      {detail.egress.some((e) => !e.enabledHere) && (
        <Notice tone="info" role="status">
          {detail.egress
            .filter((e) => !e.enabledHere)
            .map((e) => `Needs ${e.host} — not enabled here.`)
            .join(" ")}{" "}
          It installs anyway; runs can't reach those hosts until a Team admin enables them.
        </Notice>
      )}
      {deprecated && (
        <Notice tone="warn" role="status">
          {version} is deprecated: it installs with a warning, and only a Team admin can install it.
        </Notice>
      )}
    </Section>
  );
}
