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
  type AgentEval,
} from "../../../../lib/admin/api/team/agent-builder";
import {
  EMPTY_FORM,
  fromFrontmatter,
  validateForm,
  type FieldErrors,
  type FormState,
} from "../../../../lib/admin/agent-builder/form-model";
import { isSkillSlug } from "../../../../lib/admin/skills/reach";
import {
  Button,
  Field,
  Notice,
  PageHeader,
  Section,
  Textarea,
  TextInput,
  useConfirm,
} from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { MutationStatus } from "../../error-notice";
import { ResourceView } from "../../parts";
import { useMutation, useResource } from "../../use-resource";
import { AgentQuality } from "./agent-quality";
import { EvalStatus } from "./eval-status";
import { fieldError } from "./field-errors";
import { FrontmatterForm } from "./frontmatter-form";
import { OrbitExportButton } from "./orbit-export-button";
import { PublishDialog } from "./publish-dialog";
import { AgentTestPane } from "./test-pane";
import { VersionHistory } from "./version-history";

export type BuilderScope = "team" | "personal";

/** Where each scope's builder lives: the admin console for team agents, "My agents" otherwise. */
const HOME: Readonly<Record<BuilderScope, { base: string; back: string; title: string }>> = {
  team: { base: "/admin/team/agents", back: "All team agents", title: "New team agent" },
  personal: { base: "/me/agents", back: "My agents", title: "New personal agent" },
};

/**
 * Create, edit and publish an agent from one page (spec D19; `/v1/agents`, KOBE-84). The same
 * builder serves personal agents in the member's own area (KOBE-97); the server decides who may
 * edit and publish and reports it as `canEdit` / `canPublish`.
 */
export function AgentBuilderPage({
  agentId,
  scope = "team",
  addSkill,
}: {
  readonly agentId?: string;
  readonly scope?: BuilderScope;
  /** A skill page's "Add to agent…" (KOBE-297): the draft opens with this skill added. */
  readonly addSkill?: string | undefined;
}) {
  const teamId = useTeamAccess().team.id;
  return agentId ? (
    <ExistingAgent teamId={teamId} agentId={agentId} scope={scope} addSkill={addSkill} />
  ) : (
    <Builder teamId={teamId} initial={null} scope={scope} />
  );
}

function ExistingAgent({
  teamId,
  agentId,
  scope,
  addSkill,
}: {
  readonly teamId: string;
  readonly agentId: string;
  readonly scope: BuilderScope;
  readonly addSkill?: string | undefined;
}) {
  const { state } = useResource(() => getTeamAgent(teamId, agentId));
  if (state.status !== "ready") {
    // Loading or refused: the way back stays on the page.
    return (
      <>
        <BackLink scope={scope} />
        <ResourceView state={state} label="agent">
          {() => null}
        </ResourceView>
      </>
    );
  }
  return <Builder teamId={teamId} initial={state.data.agent} scope={scope} addSkill={addSkill} />;
}

function BackLink({ scope }: { readonly scope: BuilderScope }) {
  const home = HOME[scope];
  return (
    <p className="m-0 mb-1 text-sm">
      <Link href={home.base}>{home.back}</Link>
    </p>
  );
}

/** The form with `slug` appended to its skills (unless listed already or not a skill name). */
function withSkill(form: FormState, slug: string | undefined): FormState {
  if (slug === undefined || !isSkillSlug(slug)) return form;
  const listed = form.skills.split("\n").map((l) => l.trim());
  if (listed.includes(slug)) return form;
  return { ...form, skills: [...listed.filter((l) => l !== ""), slug].join("\n") };
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
  scope,
  addSkill,
}: {
  readonly teamId: string;
  readonly initial: AgentDetail | null;
  readonly scope: BuilderScope;
  readonly addSkill?: string | undefined;
}) {
  const home = HOME[scope];
  const [agent, setAgent] = useState(initial);
  const [baseline, setBaseline] = useState(() => baselineOf(initial));
  const [form, setForm] = useState(() =>
    initial?.canEdit && !initial.archivedAt ? withSkill(baseline.form, addSkill) : baseline.form,
  );
  const added = form.skills !== baseline.form.skills ? addSkill : undefined;
  const [prompt, setPrompt] = useState(baseline.prompt);
  const [slug, setSlug] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [testing, setTesting] = useState(false);
  // KOBE-93: the Orbit eval a Publish started (the draft is "evaluating" until it ends).
  const [evalStarted, setEvalStarted] = useState<AgentEval | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
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
          : await createTeamAgent(teamId, { ...body, slug: slug || undefined }, scope);
        if (res.ok && agent) apply(res.data.agent);
        if (res.ok && !agent) window.location.assign(`${home.base}/${res.data.agent.id}`);
        return res;
      },
      () => (agent ? "Draft saved." : "Agent created."),
    );
    return done;
  }

  async function restore(version: number, trigger: HTMLElement | null) {
    if (!agent) return;
    const yes = await confirm(
      {
        title: `Restore version ${version} as the newest version?`,
        ...(dirty ? { description: "Your unsaved changes in the form are replaced." } : {}),
        confirmLabel: `Restore version ${version}`,
        tone: "primary",
      },
      trigger,
    );
    if (!yes) return;
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

  /** An eval ended: a pass published a version, so take the server's agent and history. */
  async function evalFinished(finished: AgentEval) {
    if (finished.status !== "passed" || !agent) return;
    const res = await getTeamAgent(teamId, agent.id);
    if (res.ok) {
      apply(res.data.agent);
      setHistoryKey((k) => k + 1);
      if (finished.version !== null) setPublished(`Published v${finished.version}.`);
    }
  }

  // Publishing is its own right (the server checks `access.publish`), separate from editing.
  const canPublish = agent !== null && !readOnly && agent.canPublish === true;
  // Exporting needs the right to read the definition, not edit rights (archived agents export too).
  const canExport = agent !== null && agent.canExport === true;

  return (
    <>
      <PageHeader
        title={agent ? agent.name : home.title}
        back={<Link href={home.base}>{home.back}</Link>}
      />
      {agent?.archivedAt && (
        <Notice tone="warn">
          <p>This agent is archived, so it can&apos;t be changed.</p>
        </Notice>
      )}
      {agent?.status === "suspended" && (
        <Notice tone="warn">
          <p>
            This agent is suspended by a team admin, so it can&apos;t start new runs. You can still
            edit and publish it.
          </p>
        </Notice>
      )}
      {attempted && problemCount > 0 && (
        <Notice tone="error">
          <p>
            Fix {problemCount} {problemCount === 1 ? "problem" : "problems"} before saving.
          </p>
        </Notice>
      )}
      {added !== undefined && dirty && (
        <p role="status" className="text-sm text-console-muted">
          Added {added} to this agent&apos;s skills. Save the draft and publish it to use the skill.
        </p>
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
            error={fieldError(errors.slug)}
            className="my-4"
          >
            <TextInput type="text" value={slug} onChange={(e) => setSlug(e.target.value)} />
          </Field>
        )}
        <FrontmatterForm form={form} errors={errors} readOnly={readOnly} onChange={setForm} />
        <Field
          label="System prompt"
          hint="What the agent is told at the start of every conversation."
          error={fieldError(errors.prompt)}
        >
          <Textarea
            className="min-h-72 w-full resize-y font-mono read-only:bg-console-panel"
            value={prompt}
            readOnly={readOnly}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>
        {errors.form && (
          <p role="alert" className="m-0 mt-2 text-sm font-medium text-console-danger">
            {errors.form.join(" ")}
          </p>
        )}
        {!readOnly && (
          <div className="my-4 flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={mutation.pending}>
              {agent ? "Save draft" : "Create agent"}
            </Button>
            {canPublish && (
              <Button
                ref={publishButton}
                disabled={dirty || mutation.pending || evaluating}
                onClick={() => setPublishing(true)}
              >
                {evaluating ? "Evaluating…" : "Publish…"}
              </Button>
            )}
            {canPublish && dirty && (
              <span className="text-sm text-console-muted">Save your changes to publish them.</span>
            )}
            {agent && !dirty && (
              <span className="text-sm text-console-muted">
                {agent.currentVersion === null
                  ? "Never published."
                  : `Current version: v${agent.currentVersion}.`}
              </span>
            )}
          </div>
        )}
      </form>
      {agent && !readOnly && (
        <Section
          id="test-chat-heading"
          title="Test chat"
          description={`Chat with the unpublished draft as last saved${dirty ? " (save your edits first)" : ""}. It runs with the same policy, approvals and budgets as a published agent.`}
        >
          {testing ? (
            <>
              <AgentTestPane key={agent.id} teamId={teamId} agentId={agent.id} />
              <Button onClick={() => setTesting(false)}>Close test chat</Button>
            </>
          ) : (
            <Button onClick={() => setTesting(true)}>Test chat</Button>
          )}
        </Section>
      )}
      {agent && canExport && agent.currentVersion !== null && (
        <div className="my-4 flex flex-wrap items-center gap-2">
          <OrbitExportButton
            teamId={teamId}
            agentId={agent.id}
            agentSlug={agent.slug}
            version={agent.currentVersion}
          />
          <span className="text-sm text-console-muted">
            Downloads v{agent.currentVersion} as Orbit YAML for safety evaluation.
          </span>
        </div>
      )}
      {agent && !agent.archivedAt && (
        <EvalStatus
          teamId={teamId}
          agentId={agent.id}
          started={evalStarted}
          canRetry={canPublish && !dirty}
          onActiveChange={setEvaluating}
          onFinished={(finished) => void evalFinished(finished)}
          onRetry={() => setPublishing(true)}
        />
      )}
      {publishing && agent && validation.ok && (
        <PublishDialog
          teamId={teamId}
          agent={agent}
          warnings={validation.warnings}
          // The Publish button, or, while an evaluation it started runs (the button is disabled),
          // the evaluation's heading.
          returnFocus={() =>
            publishButton.current?.disabled === false
              ? publishButton.current
              : document.getElementById("eval-heading")
          }
          onClose={() => setPublishing(false)}
          onEvaluating={(started) => {
            setEvalStarted(started);
            setPublishing(false);
          }}
          onPublished={(result, version) => {
            apply(result.agent);
            setHistoryKey((k) => k + 1);
            setPublished(`Published v${version}.`);
            setPublishing(false);
          }}
        />
      )}
      {agent && <AgentQuality teamId={teamId} agentId={agent.id} />}
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
          onRestore={(v, trigger) => void restore(v, trigger)}
        />
      )}
      {confirmDialog}
    </>
  );
}
