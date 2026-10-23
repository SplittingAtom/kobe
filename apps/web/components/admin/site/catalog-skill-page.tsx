"use client";

import Link from "next/link";
import { useState } from "react";
import {
  getCatalogSkill,
  startSiteDraft,
  type CatalogSkillView,
  type CatalogVersionRow,
} from "../../../lib/admin/api/site/catalog-edit";
import {
  Badge,
  Button,
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
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { useNavigate } from "../../shell/use-navigate";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { DetachedBadge, KobePanel } from "./catalog-kobe-panel";
import { CatalogVersionPanel } from "./catalog-version-panel";

export const CATALOG_HOME = "/admin/site/skill-tags";
export const catalogSkillHref = (id: string) =>
  `/admin/site/skill-catalog/${encodeURIComponent(id)}`;
export const catalogEditHref = (id: string) => `${catalogSkillHref(id)}/edit`;

const PUBLISHER: Readonly<Record<CatalogVersionRow["publisher"], string>> = {
  kobe: "Kobe",
  maintainer: "Maintainer",
  site: "Site",
};

/** Why the skill can't be edited now, or null. */
export function editBlock(skill: CatalogSkillView): string | null {
  if (skill.retired)
    return `${skill.name} is ${skill.status}. Restore it first (Skill tags → Versions) to edit it.`;
  if (skill.blocklisted)
    return `Bytes of ${skill.name} are on the Site's blocklist. Unblock them before editing it.`;
  return null;
}

function Versions({
  skill,
  shown,
  onShow,
  onEdit,
  pending,
}: {
  readonly skill: CatalogSkillView;
  readonly shown: string | null;
  readonly onShow: (id: string) => void;
  readonly onEdit: (v: CatalogVersionRow, trigger: HTMLElement | null) => void;
  readonly pending: boolean;
}) {
  const blocked = editBlock(skill) !== null;
  return (
    <Table caption={`Versions of ${skill.name}`} hideCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Version</TableHeader>
          <TableHeader>Publisher</TableHeader>
          <TableHeader>State</TableHeader>
          <TableHeader>Scan</TableHeader>
          <TableHeader>Published</TableHeader>
          <TableHeader>
            <span className="sr-only">Actions</span>
          </TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {skill.versions.map((v) => (
          <TableRow key={v.id}>
            <TableRowHeader>
              {v.semver}
              {v.changelog && (
                <div className="text-sm font-normal text-console-muted">{v.changelog}</div>
              )}
            </TableRowHeader>
            <TableCell>
              {PUBLISHER[v.publisher]}
              {v.submittedBy ? ` (${v.submittedBy})` : ""}
            </TableCell>
            <TableCell>{v.state}</TableCell>
            <TableCell>{v.verdict}</TableCell>
            <TableCell className="whitespace-nowrap">
              {v.approvedAt ? <DateTime value={v.approvedAt} /> : "Not published"}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <Button
                variant="ghost"
                aria-expanded={shown === v.id}
                aria-label={`Files of ${skill.name} ${v.semver}`}
                onClick={() => onShow(v.id)}
              >
                Open
              </Button>
              <Button
                variant="ghost"
                disabled={blocked || pending || !v.stored}
                aria-label={`Edit ${skill.name} from ${v.semver}`}
                onClick={(e) => onEdit(v, eventTrigger(e))}
              >
                Edit from here
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SkillView({
  skill,
  reload,
}: {
  readonly skill: CatalogSkillView;
  readonly reload: () => void;
}) {
  const [shown, setShown] = useState<string | null>(skill.versions[0]?.id ?? null);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const navigate = useNavigate();
  const blocked = editBlock(skill);

  async function edit(v: CatalogVersionRow, trigger: HTMLElement | null) {
    let replace = false;
    if (skill.draft) {
      const yes = await confirm(
        {
          title: `Replace the site draft of ${skill.name}?`,
          description: `A site draft from ${skill.draft.baseSemver} exists (last changed by ${skill.draft.updatedBy}). Starting from ${v.semver} discards it.`,
          confirmLabel: "Replace draft",
        },
        trigger,
      );
      if (!yes) return;
      replace = true;
    } else if (skill.kobe && !skill.kobe.detached) {
      const yes = await confirm(
        {
          title: `Edit ${skill.name}, a Kobe skill?`,
          description:
            "Editing detaches it: Kobe releases stop updating it until you reset it to Kobe.",
          confirmLabel: "Edit and detach",
        },
        trigger,
      );
      if (!yes) return;
    }
    const done = await mutation.run(() => startSiteDraft(skill.id, v.id, replace));
    if (done) navigate(catalogEditHref(skill.id));
  }

  return (
    <>
      <PageHeader
        title={
          <>
            {skill.name} <Badge>{skill.publisher === "kobe" ? "Kobe" : "Team-published"}</Badge>{" "}
            <DetachedBadge kobe={skill.kobe} />
          </>
        }
        back={<Link href={CATALOG_HOME}>Skill tags</Link>}
        description={skill.summary}
        actions={
          skill.draft && !blocked ? (
            <Link href={catalogEditHref(skill.id)}>Continue the site draft</Link>
          ) : null
        }
      />
      {blocked && <Notice tone="warn">{blocked}</Notice>}
      {skill.draft && (
        <Notice tone="info">
          <p className="m-0">
            A site draft from {skill.draft.baseSemver} is open (last changed by{" "}
            {skill.draft.updatedBy}).
          </p>
        </Notice>
      )}
      <KobePanel skillId={skill.id} name={skill.name} kobe={skill.kobe} onReset={reload} />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <Section title="Versions">
        <Versions
          skill={skill}
          shown={shown}
          onShow={setShown}
          onEdit={(v, t) => void edit(v, t)}
          pending={mutation.pending}
        />
      </Section>
      {shown && (
        <Section title={`Version ${skill.versions.find((v) => v.id === shown)?.semver ?? ""}`}>
          <CatalogVersionPanel key={shown} skillId={skill.id} versionId={shown} />
        </Section>
      )}
      {confirmDialog}
    </>
  );
}

/**
 * One catalog skill in the Site Console (KOBE-495): its versions with publisher and state, each
 * version's files read-only, frontmatter, scan, provenance and hashes; Edit opens a site draft
 * from a chosen version. A Kobe skill shows whether it is detached, with Compare and Reset.
 */
export function CatalogSkillPage({ skillId }: { readonly skillId: string }) {
  const { state, reload } = useResource(() => getCatalogSkill(skillId));
  return (
    <ResourceView state={state} label="the catalog skill">
      {(skill) => <SkillView key={JSON.stringify(skill.kobe)} skill={skill} reload={reload} />}
    </ResourceView>
  );
}
