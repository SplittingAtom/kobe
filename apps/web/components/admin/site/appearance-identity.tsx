"use client";

import { APP_NAME_MAX_LENGTH, appNameSchema } from "@kobe/protocol";
import { Checkbox, Field, TextInput } from "../../ui/console";

/** The rule a draft name breaks, in the schema's own words (packages/protocol branding.ts). */
export function nameError(name: string): string | null {
  const parsed = appNameSchema.safeParse(name);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the name.");
}

/** The site name with its counter and the browser-tab example, and the "show the name" switch. */
export function IdentityFields({
  appName,
  onAppName,
  showName,
  onShowName,
}: {
  readonly appName: string;
  readonly onAppName: (name: string) => void;
  readonly showName: boolean;
  readonly onShowName: (show: boolean) => void;
}) {
  const error = nameError(appName);
  const length = [...appName.trim()].length;
  const example = error === null ? appName.trim() : "…";
  return (
    <>
      <Field
        label="Site name"
        hint="Shown in the header, in browser tabs, at sign-in and in Kobe's emails."
        error={error}
        required
      >
        <TextInput
          className="w-80 max-w-full"
          value={appName}
          autoComplete="off"
          aria-describedby="appearance-name-count appearance-name-example"
          onChange={(e) => onAppName(e.target.value)}
        />
      </Field>
      <p id="appearance-name-count" className="m-0 mt-1 text-sm text-console-muted">
        {length} of {APP_NAME_MAX_LENGTH} characters
      </p>
      <p id="appearance-name-example" className="m-0 mt-1 text-sm text-console-muted">
        A browser tab reads:{" "}
        <span className="font-medium text-console-fg">Site console · {example}</span>
      </p>
      <Checkbox
        className="mt-3"
        label="Show the name next to the logo"
        hint="Without a logo the name always shows. Hidden, it still names the site for screen readers."
        checked={showName}
        onChange={(e) => onShowName(e.target.checked)}
      />
    </>
  );
}
