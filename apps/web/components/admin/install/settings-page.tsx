"use client";

import { useState, type FormEvent } from "react";
import {
  AUDIT_PII_RETENTION_HOURS,
  getInstallSettings,
  putInstallSettings,
  type InstallSettings,
} from "../../../lib/admin/api/install/settings";
import { canTurnOffRequiredTwoFactor } from "../../../lib/admin/rules";
import { useInstallAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

/**
 * Install settings (`/v1/install/settings`): required two-factor authentication (D7) and how long
 * audit events keep the client IP address and user agent (KOBE-17).
 */
export function SettingsPage() {
  const { state, reload } = useResource(getInstallSettings);
  return (
    <>
      <h1>Settings</h1>
      <ResourceView state={state} label="settings">
        {(settings) => (
          <>
            <SettingsForm settings={settings} onSaved={reload} />
            <AuditPrivacyForm settings={settings} onSaved={reload} />
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
  readonly settings: InstallSettings;
  readonly onSaved: () => void;
}) {
  const access = useInstallAccess();
  const mutation = useMutation();
  const [requireTwoFactor, setRequireTwoFactor] = useState(settings.requireTwoFactor);
  const locked = settings.requireTwoFactor && !canTurnOffRequiredTwoFactor(access.installRole);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => putInstallSettings({ requireTwoFactor }),
      (saved) =>
        saved.requireTwoFactor
          ? "Two-factor authentication is now required. People without it are asked to set it up at their next request."
          : "Two-factor authentication is now optional.",
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Install settings">
      <fieldset>
        <legend>Sign-in</legend>
        <label>
          <input
            type="checkbox"
            checked={requireTwoFactor}
            disabled={locked}
            aria-describedby="require-2fa-hint"
            onChange={(e) => setRequireTwoFactor(e.target.checked)}
          />{" "}
          Require two-factor authentication for everyone
        </label>
        <p id="require-2fa-hint" className={styles.hint}>
          {locked
            ? "Only the Owner can turn this off."
            : "Everyone must enrol an authenticator app before they can use Kobe."}
        </p>
      </fieldset>
      <button
        type="submit"
        disabled={mutation.pending || requireTwoFactor === settings.requireTwoFactor}
      >
        Save
      </button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}

function AuditPrivacyForm({
  settings,
  onSaved,
}: {
  readonly settings: InstallSettings;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const saved = settings.auditPiiRetentionHours ?? AUDIT_PII_RETENTION_HOURS.default;
  const [hours, setHours] = useState(String(saved));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => putInstallSettings({ auditPiiRetentionHours: Number(hours) }),
      (next) =>
        `Audit events now keep IP addresses and user agents for ${next.auditPiiRetentionHours ?? hours} hours.`,
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Audit log privacy">
      <fieldset>
        <legend>Audit log privacy</legend>
        <label>
          Keep IP addresses and user agents for (hours){" "}
          <input
            type="number"
            required
            min={AUDIT_PII_RETENTION_HOURS.min}
            max={AUDIT_PII_RETENTION_HOURS.max}
            step={1}
            value={hours}
            aria-describedby="audit-pii-hint"
            onChange={(e) => setHours(e.target.value)}
          />
        </label>
        <p id="audit-pii-hint" className={styles.hint}>
          After this, the client IP address and user agent are erased from audit events. The events
          themselves are kept, and the audit chain still verifies. Data under a legal hold is kept
          until the hold is released. 1 to 8760 hours; the default is 12.
        </p>
      </fieldset>
      <button type="submit" disabled={mutation.pending || Number(hours) === saved}>
        Save retention
      </button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
