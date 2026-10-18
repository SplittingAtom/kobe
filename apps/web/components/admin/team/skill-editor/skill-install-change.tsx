"use client";

import { useState } from "react";
import {
  putTeamSkillInstall,
  type CatalogInstall,
  type SkillInstallResult,
} from "../../../../lib/admin/api/team/skill-installs";
import { Button, Field, FormRow, Select, TextInput } from "../../../ui/console";

const ACCESS_LABEL: Record<CatalogInstall["access"], string> = {
  available: "Available",
  default_on: "On by default",
  required: "Required",
  hidden: "Hidden",
};
const PIN_LABEL: Record<CatalogInstall["pinMode"], string> = {
  pinned: "Pinned",
  within_major: "Track within major",
  latest: "Track latest",
};

/** What the install answer says, with the warning from 5 Required skills (SK27). */
export function skillInstallNotice(name: string, r: SkillInstallResult): string {
  const base = `${name} is set to ${r.semver}${r.deprecated ? " (deprecated)" : ""}.`;
  return r.warning === "many_required"
    ? `${base} The team now has ${r.requiredCount} Required skills: they load in every run and count first against the limit of 64.`
    : base;
}

/**
 * Change an install's version, pin mode and access (KOBE-316): Team admins, and Builders while
 * "Builders may install catalog skills" is on. Builders get no Required option; the server also
 * refuses them deprecated versions and installs a Team admin or the Site default made.
 */
export function SkillInstallChangeForm({
  teamId,
  install,
  mayRequire,
  pending,
  run,
}: {
  readonly teamId: string;
  readonly install: CatalogInstall;
  readonly mayRequire: boolean;
  readonly pending: boolean;
  readonly run: (
    action: () => ReturnType<typeof putTeamSkillInstall>,
    notice: (r: SkillInstallResult) => string,
  ) => Promise<boolean>;
}) {
  const [version, setVersion] = useState(install.semver);
  const [pinMode, setPinMode] = useState(install.pinMode);
  const [access, setAccess] = useState(install.access);
  return (
    <details>
      <summary>Change</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => putTeamSkillInstall(teamId, install.skillId, { version, pinMode, access }),
            (r) => skillInstallNotice(install.name, r),
          );
        }}
      >
        <FormRow className="mb-1">
          <Field label={`Version of ${install.name}`}>
            <TextInput value={version} onChange={(e) => setVersion(e.target.value.trim())} />
          </Field>
          <Field label={`Pin mode of ${install.name}`}>
            <Select
              value={pinMode}
              onChange={(e) => setPinMode(e.target.value as CatalogInstall["pinMode"])}
            >
              {(Object.keys(PIN_LABEL) as CatalogInstall["pinMode"][]).map((p) => (
                <option key={p} value={p}>
                  {PIN_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`Access of ${install.name}`}>
            <Select
              value={access}
              onChange={(e) => setAccess(e.target.value as CatalogInstall["access"])}
            >
              {(Object.keys(ACCESS_LABEL) as CatalogInstall["access"][])
                .filter((a) => mayRequire || a !== "required")
                .map((a) => (
                  <option key={a} value={a}>
                    {ACCESS_LABEL[a]}
                  </option>
                ))}
            </Select>
          </Field>
          <Button type="submit" disabled={pending || version === ""}>
            Save
          </Button>
        </FormRow>
      </form>
    </details>
  );
}
