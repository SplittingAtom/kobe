"use client";

import { useState, type FormEvent } from "react";
import {
  TAG_PATTERN,
  createTopicTag,
  listCatalogTags,
  updateTopicTag,
  type CatalogTag,
} from "../../../lib/admin/api/site/skill-tags";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  FormRow,
  PageHeader,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  TextInput,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";
import { CatalogTagsSection, DefaultSyncsSection } from "./skill-catalog-tags";

const TAG_HINT = "Lowercase letters, digits and hyphens, up to 32 characters.";

/**
 * Catalog tags (KOBE-314, SK5–SK8): the topic vocabulary, each catalog skill's tags (the Default
 * system tag puts a skill in every team), Default moves to a new major and the Default syncs.
 */
export function SkillTagsPage() {
  const tags = useResource(() => listCatalogTags());
  const mutation = useMutation();
  // Bumping `generation` reloads the catalog and syncs after a tag change.
  const [generation, setGeneration] = useState(0);
  const changed = () => {
    tags.reload();
    setGeneration((g) => g + 1);
  };
  return (
    <>
      <PageHeader
        title="Skill tags"
        description="Topic tags drive catalog browsing. The Default system tag installs a skill in every team (On by default, tracking its major) except teams that removed it; new teams get it too. Removing Default leaves every install in place as a team install."
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <Section id="topic-tags" title="Topic tags">
        <AddTag mutation={mutation} onAdded={changed} />
        <ResourceView state={tags.state} label="tags">
          {(all) => <TopicTags tags={all} mutation={mutation} onChanged={changed} />}
        </ResourceView>
      </Section>
      <ResourceView state={tags.state} label="tags">
        {(all) => (
          <CatalogTagsSection
            key={`catalog-${generation}`}
            tags={all}
            mutation={mutation}
            onChanged={() => setGeneration((g) => g + 1)}
          />
        )}
      </ResourceView>
      <DefaultSyncsSection key={`syncs-${generation}`} />
    </>
  );
}

function AddTag({
  mutation,
  onAdded,
}: {
  readonly mutation: Mutation;
  readonly onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const clean = name.trim();
    if (!TAG_PATTERN.test(clean)) {
      setError(TAG_HINT);
      return;
    }
    setError(null);
    const done = await mutation.run(
      () => createTopicTag(clean),
      () => `Added the topic tag ${clean}.`,
    );
    if (done) {
      setName("");
      onAdded();
    }
  }
  return (
    <form onSubmit={onSubmit} aria-label="Add a topic tag">
      <FormRow>
        <Field label="New topic tag" error={error}>
          <TextInput
            required
            maxLength={32}
            spellCheck={false}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={mutation.pending}>
          Add tag
        </Button>
      </FormRow>
    </form>
  );
}

function TopicTags({
  tags,
  mutation,
  onChanged,
}: {
  readonly tags: readonly CatalogTag[];
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const topic = tags.filter((t) => t.kind === "topic");
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly name: string } | null>(
    null,
  );
  if (topic.length === 0) return <EmptyState title="No topic tags yet." />;

  async function change(tag: CatalogTag, body: { name?: string; status?: "active" | "retired" }) {
    const done = await mutation.run(
      () => updateTopicTag(tag.id, body),
      (r) => `Saved the topic tag ${r.tag.name}.`,
    );
    if (done) {
      setRenaming(null);
      onChanged();
    }
  }

  return (
    <Table caption="Topic tags" hideCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Tag</TableHeader>
          <TableHeader>Status</TableHeader>
          <TableHeader>
            <span className="sr-only">Actions</span>
          </TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {topic.map((tag) => (
          <TableRow key={tag.id}>
            <TableRowHeader>
              {renaming?.id === tag.id ? (
                <Field label={`New name for ${tag.name}`}>
                  <TextInput
                    maxLength={32}
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: tag.id, name: e.target.value })}
                  />
                </Field>
              ) : (
                <code className="font-normal">{tag.name}</code>
              )}
            </TableRowHeader>
            <TableCell>
              {tag.status === "active" ? "Active" : <Badge tone="attention">Retired</Badge>}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {renaming?.id === tag.id ? (
                <>
                  <Button
                    disabled={mutation.pending || !TAG_PATTERN.test(renaming.name.trim())}
                    onClick={() => void change(tag, { name: renaming.name.trim() })}
                  >
                    Save name
                  </Button>{" "}
                  <Button variant="ghost" onClick={() => setRenaming(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    aria-label={`Rename ${tag.name}`}
                    onClick={() => setRenaming({ id: tag.id, name: tag.name })}
                  >
                    Rename
                  </Button>{" "}
                  <Button
                    variant="ghost"
                    disabled={mutation.pending}
                    aria-label={`${tag.status === "active" ? "Retire" : "Restore"} ${tag.name}`}
                    onClick={() =>
                      void change(tag, { status: tag.status === "active" ? "retired" : "active" })
                    }
                  >
                    {tag.status === "active" ? "Retire" : "Restore"}
                  </Button>
                </>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
