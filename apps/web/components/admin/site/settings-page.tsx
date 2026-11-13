"use client";

import { useState, type FormEvent } from "react";
import {
  AUDIT_PII_RETENTION_HOURS,
  KOBE_MCP_MODE_LABELS,
  getSiteSettings,
  putSiteSettings,
  type KobeMcpMode,
  type SiteSettings,
} from "../../../lib/admin/api/site/settings";
import { canTurnOffRequiredTwoFactor } from "../../../lib/admin/rules";
import {
  Button,
  Checkbox,
  ChoiceGroup,
  Field,
  PageHeader,
  Radio,
  TextInput,
} from "../../ui/console";
import { useSiteAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { MemorySwitchesSection } from "./memory-switches";

/**
 * Site settings (`/v1/site/settings`): required two-factor authentication (D7), how long audit
 * events keep the client IP address and user agent (KOBE-17), and the Kobe MCP switch (KOBE-623).
 */
export function SettingsPage() {
  const { state, reload } = useResource(getSiteSettings);
  return (
    <>
      <PageHeader title="Settings" />
      <ResourceView state={state} label="settings">
        {(settings) => (
          <>
            <SettingsForm settings={settings} onSaved={reload} />
            <AuditPrivacyForm settings={settings} onSaved={reload} />
            {settings.kobeMcpMode !== undefined && (
              <KobeMcpForm mode={settings.kobeMcpMode} onSaved={reload} />
            )}
            <MemorySwitchesSection />
          </>
        )}
      </ResourceView>
    </>
  );
}

function SettingsForm({
  settings,
  onSaved,
}: {
  readonly settings: SiteSettings;
  readonly onSaved: () => void;
}) {
  const access = useSiteAccess();
  const mutation = useMutation();
  const [requireTwoFactor, setRequireTwoFactor] = useState(settings.requireTwoFactor);
  const locked = settings.requireTwoFactor && !canTurnOffRequiredTwoFactor(access.siteRole);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => putSiteSettings({ requireTwoFactor }),
      (saved) =>
        saved.requireTwoFactor
          ? "Two-factor authentication is now required. People without it are asked to set it up at their next request."
          : "Two-factor authentication is now optional.",
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Site settings">
      <ChoiceGroup legend="Sign-in" stacked className="my-4">
        <Checkbox
          label="Require two-factor authentication for everyone"
          hint={
            locked
              ? "Only the Owner can turn this off."
              : "Everyone must enrol an authenticator app before they can use Kobe. Single sign-on counts only when your organization's sign-in proves multi-factor authentication; otherwise it is refused."
          }
          checked={requireTwoFactor}
          disabled={locked}
          onChange={(e) => setRequireTwoFactor(e.target.checked)}
        />
      </ChoiceGroup>
      <Button
        type="submit"
        variant="primary"
        disabled={mutation.pending || requireTwoFactor === settings.requireTwoFactor}
      >
        Save
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}

function AuditPrivacyForm({
  settings,
  onSaved,
}: {
  readonly settings: SiteSettings;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const saved = settings.auditPiiRetentionHours ?? AUDIT_PII_RETENTION_HOURS.default;
  const [hours, setHours] = useState(String(saved));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => putSiteSettings({ auditPiiRetentionHours: Number(hours) }),
      (next) =>
        `Audit events now keep IP addresses and user agents for ${next.auditPiiRetentionHours ?? hours} hours.`,
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Audit log privacy">
      <ChoiceGroup legend="Audit log privacy" stacked className="my-4">
        <Field
          label="Keep IP addresses and user agents for (hours)"
          hint="After this, the client IP address and user agent are erased from audit events. The events themselves are kept, and the audit chain still verifies. Data under a legal hold is kept until the hold is released. 1 to 8760 hours; the default is 12."
        >
          <TextInput
            type="number"
            required
            className="w-28"
            min={AUDIT_PII_RETENTION_HOURS.min}
            max={AUDIT_PII_RETENTION_HOURS.max}
            step={1}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </Field>
      </ChoiceGroup>
      <Button
        type="submit"
        variant="primary"
        disabled={mutation.pending || Number(hours) === saved}
      >
        Save retention
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}

const KOBE_MCP_HINTS: Readonly<Record<KobeMcpMode, string>> = {
  off: "No Kobe connector: agents get neither the docs tools nor admin tools.",
  docs: "Agents can read the Kobe user guide. No admin tools in any team.",
  admin:
    "Each team admin may also turn on admin tools for their team. Agents then act as the person in the conversation, within that person's own permissions, and every change asks that person first.",
};

/**
 * The Kobe MCP switch (`kobeMcpMode`, KOBE-623, spec kobe-admin-mcp §6, KA5): off, docs only (the
 * default) or docs and admin tools. A team still chooses its own level in Team console ›
 * Connectors; this caps it for the whole site. Audited by the server.
 */
function KobeMcpForm({
  mode,
  onSaved,
}: {
  readonly mode: KobeMcpMode;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [choice, setChoice] = useState<KobeMcpMode>(mode);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => putSiteSettings({ kobeMcpMode: choice }),
      (saved) => `Kobe connector: ${KOBE_MCP_MODE_LABELS[saved.kobeMcpMode ?? choice]}.`,
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Kobe connector">
      <ChoiceGroup
        legend="Kobe connector (docs and admin from a conversation)"
        stacked
        className="my-4"
      >
        {(Object.keys(KOBE_MCP_MODE_LABELS) as KobeMcpMode[]).map((m) => (
          <Radio
            key={m}
            name="kobe-mcp-mode"
            label={KOBE_MCP_MODE_LABELS[m]}
            hint={KOBE_MCP_HINTS[m]}
            checked={choice === m}
            disabled={mutation.pending}
            onChange={() => setChoice(m)}
          />
        ))}
      </ChoiceGroup>
      <Button type="submit" variant="primary" disabled={mutation.pending || choice === mode}>
        Save Kobe connector
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
