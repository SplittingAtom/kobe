"use client";

import { useState, type FormEvent } from "react";
import {
  HASH_PATTERN,
  REASON_MAX,
  blockSkillHash,
  listBlockedSkills,
  unblockSkillHash,
  type BlockedSkill,
} from "../../../lib/admin/api/site/skill-blocklist";
import {
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
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";
import { SkillRescansSection } from "./skill-rescans-section";

/** The list's heading: focus lands here after a removal (the list reloads from its first page). */
const HEADING = "blocked-hashes";

/**
 * The site skill blocklist (spec D22; `/v1/site/skill-blocklist`, KOBE-81): bundle hashes
 * that can't be uploaded, approved or run in any team. Takes effect at once for existing versions.
 */
export function SkillBlocklistPage() {
  // Bumping `generation` remounts the list, which reloads it from the first page.
  const [generation, setGeneration] = useState(0);
  const mutation = useMutation();
  return (
    <>
      <PageHeader
        title="Skill blocklist"
        description="A skill bundle is identified by the SHA-256 of its canonical bundle, shown on each skill version. Blocking a hash stops that exact bundle everywhere on the site: it can't be uploaded again or approved by a team, and versions already uploaded are left out of runs from the next run on, in every team. Removing the hash lifts the block."
      />
      <BlockForm mutation={mutation} onAdded={() => setGeneration((g) => g + 1)} />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <Section id={HEADING} title="Blocked skill hashes">
        <BlockedList
          key={generation}
          mutation={mutation}
          onRemoved={() => setGeneration((g) => g + 1)}
        />
      </Section>
      <SkillRescansSection />
    </>
  );
}

function BlockForm({
  mutation,
  onAdded,
}: {
  readonly mutation: Mutation;
  readonly onAdded: () => void;
}) {
  const [hash, setHash] = useState("");
  const [reason, setReason] = useState("");
  const [hashError, setHashError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const clean = hash.trim().toLowerCase();
    if (!HASH_PATTERN.test(clean)) {
      setHashError("A SHA-256 hash is 64 hexadecimal characters.");
      return;
    }
    setHashError(null);
    const done = await mutation.run(
      () => blockSkillHash(clean, reason.trim()),
      () => "Blocked. Existing versions with that hash are unusable from now on.",
    );
    if (done) {
      setHash("");
      setReason("");
      onAdded();
    }
  }

  return (
    <form onSubmit={onSubmit} aria-label="Block a hash">
      <FormRow>
        <Field label="Bundle hash (SHA-256)" error={hashError}>
          <TextInput
            required
            maxLength={80}
            spellCheck={false}
            autoComplete="off"
            className="w-[36rem] max-w-full font-mono"
            value={hash}
            onChange={(e) => setHash(e.target.value)}
          />
        </Field>
        <Field label="Reason">
          <TextInput
            required
            maxLength={REASON_MAX}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={mutation.pending}>
          Block hash
        </Button>
      </FormRow>
    </form>
  );
}

function BlockedList({
  mutation,
  onRemoved,
}: {
  readonly mutation: Mutation;
  readonly onRemoved: () => void;
}) {
  const { state } = useResource(() => listBlockedSkills());
  const [more, setMore] = useState<{
    readonly entries: readonly BlockedSkill[];
    readonly cursor: string | null;
  } | null>(null);
  const paging = useMutation();
  const [confirm, confirmDialog] = useConfirm();

  return (
    <ResourceView state={state} label="blocked hashes">
      {(first) => {
        const entries = [...first.entries, ...(more?.entries ?? [])];
        const cursor = more ? more.cursor : first.nextCursor;

        async function remove(entry: BlockedSkill, trigger: HTMLElement | null) {
          const yes = await confirm(
            {
              title: `Remove ${entry.contentHash.slice(0, 12)}… from the blocklist?`,
              confirmLabel: "Remove from blocklist",
            },
            trigger,
          );
          if (!yes) return;
          const done = await mutation.run(
            () => unblockSkillHash(entry.contentHash),
            () => "Removed from the blocklist.",
          );
          if (done) {
            document.getElementById(HEADING)?.focus();
            onRemoved();
          }
        }

        async function loadMore() {
          if (!cursor) return;
          await paging.run(async () => {
            const res = await listBlockedSkills(cursor);
            if (res.ok) {
              setMore({
                entries: [...(more?.entries ?? []), ...res.data.entries],
                cursor: res.data.nextCursor,
              });
            }
            return res;
          });
        }

        if (entries.length === 0) {
          return (
            <>
              <EmptyState title="No hashes are blocked." />
              {confirmDialog}
            </>
          );
        }
        return (
          <div>
            <Table caption="Blocked skill hashes" hideCaption>
              <TableHead>
                <TableRow>
                  <TableHeader>Hash</TableHeader>
                  <TableHeader>Reason</TableHeader>
                  <TableHeader>Added</TableHeader>
                  <TableHeader>
                    <span className="sr-only">Actions</span>
                  </TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.contentHash}>
                    <TableRowHeader>
                      <code className="break-all font-normal">{e.contentHash}</code>
                    </TableRowHeader>
                    <TableCell>{e.reason}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <DateTime value={e.addedAt} />
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={mutation.pending}
                        onClick={(ev) => void remove(e, eventTrigger(ev))}
                      >
                        Remove<span className="sr-only"> {e.contentHash}</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <MutationStatus error={paging.error} notice={null} />
            {cursor ? (
              <Button disabled={paging.pending} onClick={() => void loadMore()}>
                Load more
              </Button>
            ) : null}
            {confirmDialog}
          </div>
        );
      }}
    </ResourceView>
  );
}
