"use client";

import { checkFloor, type FloorFailure, type SiteBranding } from "@kobe/protocol";
import { useState, type FormEvent } from "react";
import {
  getBranding,
  putBranding,
  resetBranding,
  type BrandingChange,
} from "../../../lib/admin/api/site/branding";
import { Button, PageHeader, Section, eventTrigger, useConfirm } from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { failureTexts, floorReason } from "./appearance-contrast";
import { AssetField } from "./appearance-asset";
import { IdentityFields, nameError } from "./appearance-identity";
import { AppearancePreview } from "./appearance-preview";
import { StylePicker, draftOf, themeOf, type StyleDraft } from "./appearance-style";

/**
 * Site console → Appearance (KOBE-501, theming plan §6; decisions TH2-TH12): the site's name,
 * logo, dark logo, favicon and style, with a live light/dark preview. Owner and Admin
 * (`site.settings.manage`; the server checks it). Files apply when uploaded; the name and the
 * style with Save, after which the page reloads so the admin sees the real header and title.
 */

const reloadWindow = () => window.location.reload();

export function AppearancePage({
  reloadPage = reloadWindow,
}: {
  /** Reloads the page after a save or a reset (a stub in tests). */
  readonly reloadPage?: () => void;
}) {
  const { state } = useResource(getBranding);
  return (
    <>
      <PageHeader
        title="Appearance"
        description="The site's name, logo, favicon and colours: every page and the sign-in page show them. Colours always keep readable contrast in the light and the dark theme."
      />
      <ResourceView state={state} label="appearance">
        {(branding) => <AppearanceEditor initial={branding} reloadPage={reloadPage} />}
      </ResourceView>
    </>
  );
}

/** Only what differs from the saved branding (the server wants at least one setting). */
function changesOf(
  saved: SiteBranding,
  appName: string,
  showName: boolean,
  draft: StyleDraft,
): BrandingChange {
  const name = appName.trim();
  const theme = themeOf(draft);
  return {
    ...(name !== saved.appName ? { appName: name } : {}),
    ...(showName !== saved.showName ? { showName } : {}),
    ...(theme !== null && JSON.stringify(theme) !== JSON.stringify(saved.theme) ? { theme } : {}),
  };
}

/** Why Save is off, when the draft cannot be saved as it stands. */
function blocked(appName: string, draft: StyleDraft): string | null {
  const name = nameError(appName);
  if (name !== null) return `Save is off until the name is fixed: ${name}.`;
  const theme = themeOf(draft);
  if (theme === null) return "Save is off until the accent is a colour such as #2449c7.";
  return theme.preset === "custom" ? floorReason(checkFloor(theme)) : null;
}

function AppearanceEditor({
  initial,
  reloadPage,
}: {
  readonly initial: SiteBranding;
  readonly reloadPage: () => void;
}) {
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const [saved, setSaved] = useState(initial);
  const [appName, setAppName] = useState(initial.appName);
  const [showName, setShowName] = useState(initial.showName);
  const [draft, setDraft] = useState(() => draftOf(initial.theme));
  const [refused, setRefused] = useState<readonly FloorFailure[]>([]);

  const change = changesOf(saved, appName, showName, draft);
  const reason = blocked(appName, draft);
  const unchanged = Object.keys(change).length === 0;
  const preview: SiteBranding = {
    ...saved,
    appName: nameError(appName) === null ? appName.trim() : saved.appName,
    showName,
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (reason !== null || unchanged) return;
    let failures: readonly FloorFailure[] = [];
    const done = await mutation.run(
      async () => {
        const res = await putBranding(change);
        if (!res.ok) failures = res.failures;
        return res;
      },
      () => "Saved. Reloading to show the new header and title…",
    );
    setRefused(failures);
    if (done) reloadPage();
  }

  async function onReset(e: { currentTarget: EventTarget | null }) {
    const yes = await confirm(
      {
        title: "Reset the appearance to Kobe's defaults?",
        description:
          "This removes the name, the logos, the favicon and the style. Every page shows Kobe's own look again.",
        confirmLabel: "Reset",
      },
      eventTrigger(e),
    );
    if (!yes) return;
    setRefused([]);
    const done = await mutation.run(resetBranding, () => "Reset to Kobe's defaults. Reloading…");
    if (done) reloadPage();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Appearance">
      <Section
        title="Identity"
        description="Files apply as soon as they are uploaded; the name waits for Save."
      >
        <IdentityFields
          appName={appName}
          onAppName={setAppName}
          showName={showName}
          onShowName={setShowName}
        />
        <AssetField kind="logo" branding={saved} onChanged={setSaved} />
        <AssetField kind="logo_dark" branding={saved} onChanged={setSaved} />
        <AssetField kind="favicon" branding={saved} onChanged={setSaved} />
      </Section>
      <Section title="Style">
        <StylePicker draft={draft} onDraft={setDraft} />
      </Section>
      <Section title="Preview" description="The draft as every page will show it, in both themes.">
        <AppearancePreview branding={preview} theme={themeOf(draft) ?? saved.theme} />
      </Section>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          disabled={mutation.pending || unchanged || reason !== null}
          {...(reason === null ? {} : { "aria-describedby": "appearance-save-reason" })}
        >
          Save
        </Button>
        <Button variant="danger" disabled={mutation.pending} onClick={(e) => void onReset(e)}>
          Reset to Kobe defaults
        </Button>
      </div>
      {reason !== null && (
        <p id="appearance-save-reason" className="m-0 mt-2 text-sm font-medium text-console-danger">
          {reason}
        </p>
      )}
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {refused.length > 0 && (
        <ul className="m-0 mt-2 ps-5 text-sm text-console-danger">
          {failureTexts(refused).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      {confirmDialog}
    </form>
  );
}
