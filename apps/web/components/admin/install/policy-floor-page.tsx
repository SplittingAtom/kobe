"use client";

import { useState, type FormEvent } from "react";
import {
  createInstallRule,
  deleteInstallRule,
  getPolicySettings,
  listInstallRules,
  putPolicySettings,
  type PolicySettings,
} from "../../../lib/admin/api/install/policy";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { RulesEditor } from "../policy-rules";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

/** The install policy floor (spec D6/D29; `/v1/install/policy`, KOBE-35). */
export function PolicyFloorPage() {
  return (
    <>
      <h1>Policy floor</h1>
      <p className={styles.hint}>
        Install rules bind every team. The floor only restricts: deny rules always win, ask rules
        always prompt, and teams can tighten but never loosen them.
      </p>
      <RulesEditor
        caption="Install rules"
        effects={["deny", "ask"]}
        load={listInstallRules}
        create={(rule) =>
          createInstallRule({ ...rule, effect: rule.effect === "ask" ? "ask" : "deny" })
        }
        remove={deleteInstallRule}
      />
      <h2>Approval defaults</h2>
      <PolicySettingsForm />
    </>
  );
}

function PolicySettingsForm() {
  const { state, reload } = useResource(getPolicySettings);
  return (
    <ResourceView state={state} label="policy settings">
      {(settings) => <SettingsForm settings={settings} onSaved={reload} />}
    </ResourceView>
  );
}

function SettingsForm({
  settings,
  onSaved,
}: {
  readonly settings: PolicySettings;
  readonly onSaved: () => void;
}) {
  const mutation = useMutation();
  const [prompt, setPrompt] = useState(settings.promptSandboxWrites);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => putPolicySettings({ promptSandboxWrites: prompt }),
      (saved) =>
        saved.promptSandboxWrites
          ? "Agents now ask before shell and file writes in their sandbox (ask-on-write)."
          : "Shell and file writes in the sandbox no longer ask in ask-on-write; the sandbox and egress policy bound them.",
    );
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label="Approval defaults">
      <label>
        <input
          type="checkbox"
          checked={prompt}
          aria-describedby="sandbox-writes-hint"
          onChange={(e) => setPrompt(e.target.checked)}
        />{" "}
        Ask before shell and file writes inside the sandbox
      </label>
      <p id="sandbox-writes-hint" className={styles.hint}>
        Applies to the ask-on-write mode. Deny and ask rules and the ask-all mode apply either way.
      </p>
      <button type="submit" disabled={mutation.pending || prompt === settings.promptSandboxWrites}>
        Save setting
      </button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
