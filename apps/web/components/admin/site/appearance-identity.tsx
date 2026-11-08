"use client";

import { APP_NAME_MAX_LENGTH, appNameSchema, type SiteBranding } from "@kobe/protocol";
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

/**
 * "Logo takes the theme colour" (KOBE-562, `branding.logo_theme_color`): an SVG logo is inlined in
 * the theme's colours and an SVG favicon follows light and dark tabs. Saved with Save; the preview
 * shows it once saved (it needs the server's inline variant).
 */
export function LogoThemeField({
  checked,
  onChange,
  saved,
}: {
  readonly checked: boolean;
  readonly onChange: (on: boolean) => void;
  /** The saved branding: says whether the stored logo can take the colour. */
  readonly saved: SiteBranding;
}) {
  const raster = saved.logoThemeColor && saved.logo !== null && saved.logo.inline === undefined;
  return (
    <>
      <Checkbox
        className="mt-3"
        label="Logo takes the theme colour"
        hint="Only an SVG logo can take it: its shapes are drawn in the theme's text colour, the brand colour on hover, in both themes, and an SVG favicon stays visible in light and dark browser tabs. A PNG, JPEG or WebP logo shows as uploaded."
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {raster && (
        <p className="m-0 mt-1 text-sm text-console-muted">
          This logo is not an SVG, so it shows as uploaded.
        </p>
      )}
      {checked !== saved.logoThemeColor && (
        <p className="m-0 mt-1 text-sm text-console-muted">Save to see it in the preview.</p>
      )}
    </>
  );
}
