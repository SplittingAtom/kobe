"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import {
  getGalleryAgent,
  getGalleryBuilderOptions,
  listGalleryVersions,
  publishGalleryAgent,
  saveGalleryAgent,
  type GalleryAgentDetail,
} from "../../../lib/admin/api/site/gallery";
import {
  firstTabWithError,
  fromFrontmatter,
  validateForm,
  type BuilderTab,
  type FieldErrors,
} from "../../../lib/admin/agent-builder/form-model";
import type { ApiResult } from "../../../lib/api/client";
import type { SkillChoices } from "../../../lib/admin/api/team/skill-choices";
import {
  Button,
  EmptyState,
  Notice,
  PageHeader,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useConfirm,
  useUnsavedChanges,
} from "../../ui/console";
import { useSiteAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { BehaviourFields } from "../team/agent-builder/behaviour-fields";
import { BuilderSourcesContext, type BuilderSources } from "../team/agent-builder/builder-sources";
import { DangerousBadge } from "../team/agent-builder/dangerous-badge";
import { IdentityFields } from "../team/agent-builder/identity-fields";
import { useMutation, useResource } from "../use-resource";
import { CustomizedBadge, UpdateAvailable } from "./gallery-customization";

const HOME = "/admin/site/gallery";
const NO_SKILLS: ApiResult<SkillChoices> = {
  ok: true,
  status: 200,
  data: { personal: [], team: [], catalog: [] },
};

/** The site's models and active connectors; skills are typed by name (none are the site's own). */
function useGallerySources(): BuilderSources {
  const { siteRole } = useSiteAccess();
  return useMemo(() => {
    const options = () => getGalleryBuilderOptions();
    return {
      models: async () => {
        const res = await options();
        return res.ok ? { ...res, data: res.data.models } : res;
      },
      connectors: async () => {
        const res = await options();
        return res.ok ? { ...res, data: res.data.connectors } : res;
      },
      skills: async () => NO_SKILLS,
      // AC1: site admins (Owner, Admin) may use Dangerous mode; the server checks it again.
      mayDangerous: siteRole === "owner" || siteRole === "admin",
      modelsHint:
        "Models in the site's catalog. Each team runs the agent with the models it enabled.",
    };
  }, [siteRole]);
}

/**
 * Edit a gallery agent (KOBE-494): the two-tab agent creator (KOBE-476) at site scope, for site
 * admins. Save draft, then Publish a new immutable version (D19). The first edit marks the agent
 * Customized: upgrades no longer change it until it is reset to the repository definition.
 */
export function GalleryAgentEditor({ agentId }: { readonly agentId: string }) {
  const { state } = useResource(() => getGalleryAgent(agentId));
  const sources = useGallerySources();
  if (state.status !== "ready") {
    return (
      <>
        <p className="m-0 mb-1 text-sm">
          <Link href={HOME}>Gallery agents</Link>
        </p>
        <ResourceView state={state} label="gallery agent">
          {() => null}
        </ResourceView>
      </>
    );
  }
  return (
    <BuilderSourcesContext.Provider value={sources}>
      <Editor initial={state.data.agent} />
    </BuilderSourcesContext.Provider>
  );
}

const baselineOf = (agent: GalleryAgentDetail) => ({
  form: fromFrontmatter(agent.frontmatter),
  prompt: agent.prompt,
});

function Editor({ initial }: { readonly initial: GalleryAgentDetail }) {
  const [agent, setAgent] = useState(initial);
  const [baseline, setBaseline] = useState(() => baselineOf(initial));
  const [form, setForm] = useState(baseline.form);
  const [prompt, setPrompt] = useState(baseline.prompt);
  const [tab, setTab] = useState<BuilderTab>("identity");
  const [attempted, setAttempted] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const publishButton = useRef<HTMLButtonElement>(null);

  const readOnly = Boolean(agent.archivedAt);
  const validation = useMemo(() => validateForm(form, prompt), [form, prompt]);
  const errors: FieldErrors = attempted && !validation.ok ? validation.errors : {};
  const dirty = JSON.stringify({ form, prompt }) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty);

  function apply(next: GalleryAgentDetail) {
    const fresh = baselineOf(next);
    setAgent(next);
    setBaseline(fresh);
    setForm(fresh.form);
    setPrompt(fresh.prompt);
    setAttempted(false);
  }

  async function save() {
    setAttempted(true);
    if (!validation.ok) {
      const fix = firstTabWithError(validation.errors);
      if (fix) setTab(fix);
      return;
    }
    const body = {
      frontmatter: validation.definition.frontmatter as Record<string, unknown>,
      prompt: validation.definition.prompt,
    };
    await mutation.run(
      async () => {
        const res = await saveGalleryAgent(agent, body);
        if (res.ok) apply(res.data.agent);
        if (!res.ok && res.error.code === "dangerous_mode_forbidden") setTab("behaviour");
        return res;
      },
      () => "Draft saved.",
    );
  }

  async function publish() {
    const yes = await confirm(
      {
        title: `Publish ${agent.name} to every team?`,
        description:
          "The saved draft becomes a new version of this gallery agent. Threads keep the version they started with; team forks keep theirs.",
        confirmLabel: "Publish",
        tone: "primary",
      },
      publishButton.current,
    );
    if (!yes) return;
    await mutation.run(
      async () => {
        const res = await publishGalleryAgent(agent);
        if (res.ok) {
          // The publish answer predates the Customized marker: read the agent again.
          const fresh = await getGalleryAgent(agent.id);
          apply(fresh.ok ? fresh.data.agent : res.data.agent);
          setHistoryKey((k) => k + 1);
        }
        return res;
      },
      (data) => `Published v${data.version.version}.`,
    );
  }

  return (
    <>
      <PageHeader
        title={agent.name}
        back={<Link href={HOME}>Gallery agents</Link>}
        actions={
          <>
            <CustomizedBadge gallery={agent.gallery} />
            {agent.dangerous && <DangerousBadge />}
          </>
        }
      />
      {agent.archivedAt ? (
        <Notice tone="warn">
          <p>This gallery agent is archived, so it can&apos;t be changed.</p>
        </Notice>
      ) : agent.gallery?.key && !agent.gallery.customized ? (
        <p className="text-sm text-console-muted">
          This agent follows the repository definition and updates with each release. Saving a
          change marks it Customized: releases then leave it as you made it, until you reset it to
          the repository.
        </p>
      ) : null}
      <UpdateAvailable
        agentId={agent.id}
        name={agent.name}
        gallery={agent.gallery}
        always
        onReset={(next) => {
          apply(next);
          setHistoryKey((k) => k + 1);
        }}
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly) void save();
        }}
        noValidate
      >
        <Tabs value={tab} onValueChange={(v) => setTab(v as BuilderTab)}>
          <TabsList label="Agent settings">
            <TabsTrigger value="identity">Identity</TabsTrigger>
            <TabsTrigger value="behaviour">Behaviour</TabsTrigger>
          </TabsList>
          <TabsContent value="identity" forceMount className="data-[state=inactive]:hidden">
            <IdentityFields
              form={form}
              prompt={prompt}
              errors={errors}
              readOnly={readOnly}
              onChange={setForm}
              onPromptChange={setPrompt}
            />
          </TabsContent>
          <TabsContent value="behaviour" forceMount className="data-[state=inactive]:hidden">
            <BehaviourFields form={form} errors={errors} readOnly={readOnly} onChange={setForm} />
          </TabsContent>
        </Tabs>
        {errors.form && (
          <p role="alert" className="m-0 mt-2 text-sm font-medium text-console-danger">
            {errors.form.join(" ")}
          </p>
        )}
        {!readOnly && (
          <div className="my-4 flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={mutation.pending}>
              Save draft
            </Button>
            <Button
              ref={publishButton}
              disabled={dirty || mutation.pending}
              onClick={() => void publish()}
            >
              Publish…
            </Button>
            <span className="text-sm text-console-muted">
              {dirty
                ? "Save your changes to publish them."
                : agent.currentVersion === null
                  ? "Never published."
                  : `Current version: v${agent.currentVersion}.`}
            </span>
          </div>
        )}
      </form>
      <GalleryVersions key={historyKey} agentId={agent.id} current={agent.currentVersion} />
      {confirmDialog}
    </>
  );
}

/** Published versions, newest first: by the repository seed or by a site admin. */
function GalleryVersions({
  agentId,
  current,
}: {
  readonly agentId: string;
  readonly current: number | null;
}) {
  const { state } = useResource(() => listGalleryVersions(agentId));
  return (
    <Section id="gallery-history-title" title="Version history">
      <ResourceView state={state} label="versions">
        {(versions) =>
          versions.length === 0 ? (
            <EmptyState title="Nothing is published yet." />
          ) : (
            <Table caption="Versions">
              <TableHead>
                <TableRow>
                  <TableHeader>Version</TableHeader>
                  <TableHeader>Published</TableHeader>
                  <TableHeader>From</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {versions.map((v) => (
                  <TableRow key={v.version}>
                    <TableRowHeader>
                      v{v.version}
                      {v.version === current && " (current)"}
                    </TableRowHeader>
                    <TableCell>
                      <DateTime value={v.publishedAt} />
                    </TableCell>
                    <TableCell>{v.publishedBy === null ? "Repository" : "Site admin"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </ResourceView>
    </Section>
  );
}
