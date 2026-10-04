"use client";

import { agentSlugSchema, slugFromName } from "@kobe/agent-file";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import {
  createTeamAgent,
  getTeamAgent,
  rollbackTeamAgent,
  saveTeamAgent,
  type AgentDetail,
} from "../../../../lib/admin/api/team/agent-builder";
import {
  EMPTY_FORM,
  fromFrontmatter,
  validateForm,
  type FieldErrors,
  type FormState,
} from "../../../../lib/admin/agent-builder/form-model";
import { useTeamAccess } from "../../console-context";
import { MutationStatus } from "../../error-notice";
import { ResourceView, confirmed } from "../../parts";
import { useMutation, useResource } from "../../use-resource";
import adminStyles from "../../admin.module.css";
import styles from "./agent-builder.module.css";
import { Field } from "./field";
import { FrontmatterForm } from "./frontmatter-form";
import { OrbitExportButton } from "./orbit-export-button";
import { PublishDialog } from "./publish-dialog";
import { VersionHistory } from "./version-history";

/** Create, edit and publish a team agent from one page (spec D19; `/v1/agents`, KOBE-84). */
export function AgentBuilderPage({ agentId }: { readonly agentId?: string }) {
  const teamId = useTeamAccess().team.id;
  return (
    <>
      <p>
        <Link href="/admin/team/agents">All team agents</Link>
      </p>
      {agentId ? (
        <ExistingAgent teamId={teamId} agentId={agentId} />
      ) : (
        <Builder teamId={teamId} initial={null} />
      )}
    </>
  );
}

function ExistingAgent({ teamId, agentId }: { readonly teamId: string; readonly agentId: string }) {
  const { state } = useResource(() => getTeamAgent(teamId, agentId));
  return (
    <ResourceView state={state} label="agent">
      {(data) => <Builder teamId={teamId} initial={data.agent} />}
    </ResourceView>
  );
}

interface Baseline {
  readonly form: FormState;
  readonly prompt: string;
}

const baselineOf = (agent: AgentDetail | null): Baseline =>
  agent
    ? { form: fromFrontmatter(agent.frontmatter), prompt: agent.prompt }
    : { form: EMPTY_FORM, prompt: "" };

function Builder({
  teamId,
  initial,
}: {
  readonly teamId: string;
  readonly initial: AgentDetail | null;
}) {
  const [agent, setAgent] = useState(initial);
  const [baseline, setBaseline] = useState(() => baselineOf(initial));
  const [form, setForm] = useState(baseline.form);
  const [prompt, setPrompt] = useState(baseline.prompt);
  const [slug, setSlug] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const mutation = useMutation();
  const publishButton = useRef<HTMLButtonElement>(null);

  const readOnly = agent !== null && (!agent.canEdit || Boolean(agent.archivedAt));
  const validation = useMemo(() => validateForm(form, prompt), [form, prompt]);
  const slugErrors = useMemo(() => {
    if (agent || slug === "" || agentSlugSchema.safeParse(slug).success) return [];
    return [
      "The slug needs 1-64 lowercase letters, digits or hyphens, starting and ending alphanumeric.",
    ];
  }, [agent, slug]);
  const errors: FieldErrors = attempted
    ? {
        ...(validation.ok ? {} : validation.errors),
        ...(slugErrors.length ? { slug: slugErrors } : {}),
      }
    : {};
  const problemCount = Object.values(errors).reduce((n, list) => n + (list?.length ?? 0), 0);
  const dirty = JSON.stringify({ form, prompt }) !== JSON.stringify(baseline);

  function apply(next: AgentDetail) {
    const fresh = baselineOf(next);
    setAgent(next);
    setBaseline(fresh);
    setForm(fresh.form);
    setPrompt(fresh.prompt);
    setAttempted(false);
  }

  async function save() {
    setAttempted(true);
    setPublished(null);
    if (!validation.ok || slugErrors.length > 0) return;
    const body = {
      frontmatter: validation.definition.frontmatter as Record<string, unknown>,
      prompt: validation.definition.prompt,
    };
    const done = await mutation.run(
      async () => {
        const res = agent
          ? await saveTeamAgent(teamId, agent, body)
          : await createTeamAgent(teamId, { ...body, slug: slug || undefined });
        if (res.ok && agent) apply(res.data.agent);
        if (res.ok && !agent) window.location.assign(`/admin/team/agents/${res.data.agent.id}`);
        return res;
      },
      () => (agent ? "Draft saved." : "Agent created."),
    );
    return done;
  }

  async function restore(version: number) {
    if (!agent) return;
    const warning = dirty ? " Your unsaved changes in the form are replaced." : "";
    if (!confirmed(`Restore version ${version} as the newest version?${warning}`)) return;
    setPublished(null);
    await mutation.run(
      async () => {
        const res = await rollbackTeamAgent(teamId, agent.id, version);
        if (res.ok) {
          apply(res.data.agent);
          setHistoryKey((k) => k + 1);
        }
        return res;
      },
      (data) => `Restored v${version} as v${data.version.version}.`,
    );
  }

  // Publishing is its own right (the server checks `access.publish`), separate from editing.
  const canPublish = agent !== null && !readOnly && agent.canPublish === true;
  // Exporting needs the right to read the definition, not edit rights (archived agents export too).
  const canExport = agent !== null && agent.canExport === true;

  return (
    <>
      <h1>{agent ? agent.name : "New team agent"}</h1>
      {agent?.archivedAt && (
        <p className={adminStyles.banner}>This agent is archived, so it can&apos;t be changed.</p>
      )}
      {attempted && problemCount > 0 && (
        <div role="alert" className={adminStyles.error}>
          <p>
            Fix {problemCount} {problemCount === 1 ? "problem" : "problems"} before saving.
          </p>
        </div>
      )}
      <MutationStatus error={mutation.error} notice={published ?? mutation.notice} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly) void save();
        }}
        noValidate
      >
        {!agent && (
          <Field
            label="Slug"
            hint={`Optional and permanent. Defaults to ${slugFromName(form.name)}.`}
            errors={errors.slug}
          >
            {(control) => (
              <input
                {...control}
                type="text"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
            )}
          </Field>
        )}
        <FrontmatterForm form={form} errors={errors} readOnly={readOnly} onChange={setForm} />
        <Field
          label="System prompt"
          hint="What the agent is told at the start of every conversation."
          errors={errors.prompt}
        >
          {(control) => (
            <textarea
              {...control}
              className={styles.prompt}
              value={prompt}
              readOnly={readOnly}
              onChange={(e) => setPrompt(e.target.value)}
            />
          )}
        </Field>
        {errors.form && <p className={styles.fieldError}>{errors.form.join(" ")}</p>}
        {!readOnly && (
          <div className={styles.toolbar}>
            <button type="submit" disabled={mutation.pending}>
              {agent ? "Save draft" : "Create agent"}
            </button>
            {canPublish && (
              <button
                ref={publishButton}
                type="button"
                disabled={dirty || mutation.pending}
                onClick={() => setPublishing(true)}
              >
                Publish…
              </button>
            )}
            {canPublish && dirty && (
              <span className={adminStyles.hint}>Save your changes to publish them.</span>
            )}
            {agent && !dirty && (
              <span className={adminStyles.hint}>
                {agent.currentVersion === null
                  ? "Never published."
                  : `Current version: v${agent.currentVersion}.`}
              </span>
            )}
          </div>
        )}
      </form>
      {agent && canExport && agent.currentVersion !== null && (
        <div className={styles.toolbar}>
          <OrbitExportButton
            teamId={teamId}
            agentId={agent.id}
            agentSlug={agent.slug}
            version={agent.currentVersion}
          />
          <span className={adminStyles.hint}>
            Downloads v{agent.currentVersion} as Orbit YAML for safety evaluation.
          </span>
        </div>
      )}
      {publishing && agent && validation.ok && (
        <PublishDialog
          teamId={teamId}
          agent={agent}
          warnings={validation.warnings}
          onClose={() => {
            setPublishing(false);
            publishButton.current?.focus();
          }}
          onPublished={(result, version) => {
            apply(result.agent);
            setHistoryKey((k) => k + 1);
            setPublished(`Published v${version}.`);
            setPublishing(false);
            publishButton.current?.focus();
          }}
        />
      )}
      {agent && (
        <VersionHistory
          key={historyKey}
          teamId={teamId}
          agentId={agent.id}
          currentVersion={agent.currentVersion}
          agentSlug={agent.slug}
          canExport={canExport}
          canRestore={canPublish}
          restoring={mutation.pending}
          onRestore={(v) => void restore(v)}
        />
      )}
    </>
  );
}
