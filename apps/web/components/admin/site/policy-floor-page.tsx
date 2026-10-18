"use client";

import { useState, type FormEvent } from "react";
import {
  createSiteRule,
  deleteSiteRule,
  getPolicySettings,
  listSiteRules,
  putPolicySettings,
  type PolicySettings,
} from "../../../lib/admin/api/site/policy";
import { getSiteRememberLimits, putSiteRememberLimits } from "../../../lib/admin/api/remember";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { RulesEditor } from "../policy-rules";
import { RememberLimitsForm } from "../remember-limits-form";
import { useMutation, useResource } from "../use-resource";
import { Button, Checkbox, PageHeader, Section } from "../../ui/console";

/** The site policy floor (spec D6/D29; `/v1/site/policy`, KOBE-35). */
export function PolicyFloorPage() {
  return (
    <>
      <PageHeader
        title="Policy floor"
        description="Site rules bind every team. The floor only restricts: deny rules always win, ask rules always prompt, and teams can tighten but never loosen them."
      />
      <RulesEditor
        caption="Site rules"
        effects={["deny", "ask"]}
        load={listSiteRules}
        create={(rule) =>
          createSiteRule({ ...rule, effect: rule.effect === "ask" ? "ask" : "deny" })
        }
        remove={deleteSiteRule}
      />
      <Section title="Approval defaults">
        <PolicySettingsForm />
      </Section>
      <Section
        title="Remember limits"
        description="What members of every team may choose when they remember an approval (KOBE-289). Teams can tighten these limits, never loosen them."
      >
        <SiteLimits />
      </Section>
    </>
  );
}

function SiteLimits() {
  const { state, reload } = useResource(getSiteRememberLimits);
  return (
    <ResourceView state={state} label="remember limits">
      {(limits) => (
        <RememberLimitsForm
          label="Site remember limits"
          initial={limits}
          save={putSiteRememberLimits}
          onSaved={reload}
        />
      )}
    </ResourceView>
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
      <Checkbox
        label="Ask before shell and file writes inside the sandbox"
        hint="Applies to the ask-on-write mode. Deny and ask rules and the ask-all mode apply either way."
        checked={prompt}
        onChange={(e) => setPrompt(e.target.checked)}
      />
      <div className="my-4">
        <Button
          type="submit"
          variant="primary"
          disabled={mutation.pending || prompt === settings.promptSandboxWrites}
        >
          Save setting
        </Button>
      </div>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}
