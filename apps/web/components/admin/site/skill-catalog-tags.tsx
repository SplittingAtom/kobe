"use client";

import { useState } from "react";
import {
  listDefaultSyncs,
  listSiteCatalog,
  moveDefaultMajor,
  putSkillTags,
  type CatalogTag,
  type DefaultSync,
  type SiteCatalogSkill,
} from "../../../lib/admin/api/site/skill-tags";
import {
  Badge,
  Button,
  Checkbox,
  ChoiceGroup,
  EmptyState,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../ui/console";
import { DateTime, ResourceView } from "../parts";
import { useResource, type Mutation } from "../use-resource";

const majorOf = (semver: string | null) => (semver ? Number(semver.split(".")[0]) : null);

/** A newer major the Default could move to: the newest approved version's, when above. */
function newerMajor(skill: SiteCatalogSkill): number | null {
  const latest = majorOf(skill.latest);
  return skill.defaultMajor !== null && latest !== null && latest > skill.defaultMajor
    ? latest
    : null;
}

function TagEditor({
  skill,
  tags,
  mutation,
  onDone,
}: {
  readonly skill: SiteCatalogSkill;
  readonly tags: readonly CatalogTag[];
  readonly mutation: Mutation;
  readonly onDone: (saved: boolean) => void;
}) {
  const [isDefault, setDefault] = useState(skill.system.includes("default"));
  const [topic, setTopic] = useState<readonly string[]>(skill.topic);
  // Active tags, and retired ones the skill still carries (they may stay, not be added).
  const choices = tags.filter(
    (t) => t.kind === "topic" && (t.status === "active" || skill.topic.includes(t.name)),
  );
  async function save() {
    const done = await mutation.run(
      () => putSkillTags(skill.id, { system: isDefault ? ["default"] : [], topic }),
      (r) =>
        r.syncId
          ? `Saved the tags of ${skill.name}. The Default sync runs in the background.`
          : `Saved the tags of ${skill.name}.`,
    );
    onDone(done);
  }
  return (
    <div className="flex flex-col gap-2">
      <Checkbox
        label="Site default"
        hint="Install in every team, On by default; teams can remove it."
        checked={isDefault}
        onChange={(e) => setDefault(e.target.checked)}
      />
      <ChoiceGroup legend="Topic tags">
        {choices.map((t) => (
          <Checkbox
            key={t.id}
            label={t.name}
            checked={topic.includes(t.name)}
            onChange={(e) =>
              setTopic(e.target.checked ? [...topic, t.name] : topic.filter((n) => n !== t.name))
            }
          />
        ))}
      </ChoiceGroup>
      <div>
        <Button variant="primary" disabled={mutation.pending} onClick={() => void save()}>
          Save tags
        </Button>{" "}
        <Button variant="ghost" onClick={() => onDone(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function DefaultCell({ skill }: { readonly skill: SiteCatalogSkill }) {
  if (skill.defaultMajor === null) return <>No</>;
  return (
    <>
      <Badge tone="accent">Site default</Badge>
      <div className="text-sm text-console-muted">
        Installs track major {skill.defaultMajor}. Opted out: {skill.optOuts ?? 0}
      </div>
    </>
  );
}

/** Each catalog skill's tags, the Default badge and the Default's major (SK5, SK6). */
export function CatalogTagsSection({
  tags,
  mutation,
  onChanged,
}: {
  readonly tags: readonly CatalogTag[];
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const { state } = useResource(() => listSiteCatalog());
  const [editing, setEditing] = useState<string | null>(null);

  async function move(skill: SiteCatalogSkill, to: number) {
    const done = await mutation.run(
      () => moveDefaultMajor(skill.id, to),
      (r) => `Moving Default installs of ${skill.name} to ${r.semver} in the background.`,
    );
    if (done) onChanged();
  }

  return (
    <Section id="catalog-tags" title="Catalog skills">
      <ResourceView state={state} label="catalog skills">
        {(skills) =>
          skills.length === 0 ? (
            <EmptyState title="The catalog has no skills yet." />
          ) : (
            <Table caption="Catalog skills" hideCaption>
              <TableHead>
                <TableRow>
                  <TableHeader>Skill</TableHeader>
                  <TableHeader>Latest</TableHeader>
                  <TableHeader>Topic tags</TableHeader>
                  <TableHeader>Default</TableHeader>
                  <TableHeader>
                    <span className="sr-only">Actions</span>
                  </TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {skills.map((s) => {
                  const major = newerMajor(s);
                  return (
                    <TableRow key={s.id}>
                      <TableRowHeader>
                        {s.name}
                        <div className="text-sm font-normal text-console-muted">{s.summary}</div>
                      </TableRowHeader>
                      <TableCell>{s.latest ?? "None approved"}</TableCell>
                      <TableCell>
                        {editing === s.id ? (
                          <TagEditor
                            skill={s}
                            tags={tags}
                            mutation={mutation}
                            onDone={(saved) => {
                              setEditing(null);
                              if (saved) onChanged();
                            }}
                          />
                        ) : s.topic.length === 0 ? (
                          "None"
                        ) : (
                          s.topic.join(", ")
                        )}
                      </TableCell>
                      <TableCell>
                        <DefaultCell skill={s} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Button
                          variant="ghost"
                          aria-label={`Edit tags of ${s.name}`}
                          onClick={() => setEditing(s.id)}
                        >
                          Edit tags
                        </Button>
                        {major !== null ? (
                          <Button
                            disabled={mutation.pending}
                            onClick={() => void move(s, major)}
                          >{`Move Default to major ${major}`}</Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )
        }
      </ResourceView>
    </Section>
  );
}

const KIND: Record<DefaultSync["kind"], string> = {
  add: "Add Default",
  remove: "Remove Default",
  move_major: "Move to a new major",
};
const STATUS: Record<DefaultSync["status"], string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
};

function Status({ sync }: { readonly sync: DefaultSync }) {
  if (sync.status === "failed")
    return (
      <Badge tone="failed">{`Failed after ${sync.attempts} attempts (${sync.lastError ?? "error"})`}</Badge>
    );
  if (sync.lastError && sync.nextAttemptAt)
    return <>{`${STATUS[sync.status]}, retrying (${sync.lastError})`}</>;
  return <>{STATUS[sync.status]}</>;
}

function Outcome({ sync }: { readonly sync: DefaultSync }) {
  const c = sync.counts;
  if (!c) return <>Hidden: fewer than 3 teams opted out or blocked it</>;
  if (sync.kind === "add")
    return (
      <>
        {c.installed} installed, {c.kept} kept their own, {c.optedOut} opted out, {c.blocked}{" "}
        blocked
      </>
    );
  if (sync.kind === "remove")
    return (
      <>
        {c.converted} now team installs, {c.optoutsCleared} opt-outs cleared
      </>
    );
  return <>{c.moved} moved</>;
}

/** The Default sync jobs and their progress (SK8); counts only, never team names. */
export function DefaultSyncsSection() {
  const { state } = useResource(() => listDefaultSyncs());
  return (
    <Section id="default-syncs" title="Default syncs">
      <ResourceView state={state} label="Default syncs">
        {(syncs) =>
          syncs.length === 0 ? (
            <EmptyState title="No Default syncs yet." />
          ) : (
            <Table caption="Default syncs" hideCaption>
              <TableHead>
                <TableRow>
                  <TableHeader>Skill</TableHeader>
                  <TableHeader>Change</TableHeader>
                  <TableHeader>Status</TableHeader>
                  <TableHeader>Progress</TableHeader>
                  <TableHeader>Outcome</TableHeader>
                  <TableHeader>Queued</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {syncs.map((j) => (
                  <TableRow key={j.id}>
                    <TableRowHeader>{j.name}</TableRowHeader>
                    <TableCell>
                      {KIND[j.kind]}
                      {j.major !== null ? ` (major ${j.major})` : ""}
                    </TableCell>
                    <TableCell>
                      <Status sync={j} />
                    </TableCell>
                    <TableCell>{`${j.teamsDone} of ${j.teamsTotal} teams`}</TableCell>
                    <TableCell>
                      <Outcome sync={j} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <DateTime value={j.createdAt} />
                    </TableCell>
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
