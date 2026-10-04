"use client";

import { useState, type FormEvent } from "react";
import {
  HASH_PATTERN,
  REASON_MAX,
  blockSkillHash,
  listBlockedSkills,
  unblockSkillHash,
  type BlockedSkill,
} from "../../../lib/admin/api/install/skill-blocklist";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";
import styles from "../admin.module.css";

/**
 * The install skill blocklist (spec D22; `/v1/install/skill-blocklist`, KOBE-81): bundle hashes
 * that can't be uploaded, approved or run in any team. Takes effect at once for existing versions.
 */
export function SkillBlocklistPage() {
  // Bumping `generation` remounts the list, which reloads it from the first page.
  const [generation, setGeneration] = useState(0);
  const mutation = useMutation();
  return (
    <>
      <h1>Skill blocklist</h1>
      <p className={styles.hint}>
        A skill bundle is identified by the SHA-256 of its canonical bundle, shown on each skill
        version. Blocking a hash stops that exact bundle everywhere in the install: it can&apos;t be
        uploaded again or approved by a team, and versions already uploaded are left out of runs
        from the next run on, in every team. Removing the hash lifts the block.
      </p>
      <BlockForm mutation={mutation} onAdded={() => setGeneration((g) => g + 1)} />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <BlockedList
        key={generation}
        mutation={mutation}
        onRemoved={() => setGeneration((g) => g + 1)}
      />
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
    <form onSubmit={onSubmit} className={styles.form} aria-label="Block a hash">
      <label>
        Bundle hash (SHA-256)
        <input
          required
          maxLength={80}
          spellCheck={false}
          autoComplete="off"
          value={hash}
          onChange={(e) => setHash(e.target.value)}
        />
      </label>
      <label>
        Reason
        <input
          required
          maxLength={REASON_MAX}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {hashError ? <p role="alert">{hashError}</p> : null}
      <button type="submit" disabled={mutation.pending}>
        Block hash
      </button>
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

  return (
    <ResourceView state={state} label="blocked hashes">
      {(first) => {
        const entries = [...first.entries, ...(more?.entries ?? [])];
        const cursor = more ? more.cursor : first.nextCursor;

        async function remove(entry: BlockedSkill) {
          if (!confirmed(`Remove ${entry.contentHash.slice(0, 12)}… from the blocklist?`)) return;
          const done = await mutation.run(
            () => unblockSkillHash(entry.contentHash),
            () => "Removed from the blocklist.",
          );
          if (done) onRemoved();
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

        if (entries.length === 0) return <p>No hashes are blocked.</p>;
        return (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Blocked skill hashes</caption>
                <thead>
                  <tr>
                    <th scope="col">Hash</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Added</th>
                    <th scope="col">
                      <span className={styles.visuallyHidden}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.contentHash}>
                      <th scope="row">
                        <code>{e.contentHash}</code>
                      </th>
                      <td>{e.reason}</td>
                      <td>
                        <DateTime value={e.addedAt} />
                      </td>
                      <td>
                        <button
                          type="button"
                          disabled={mutation.pending}
                          onClick={() => void remove(e)}
                        >
                          Remove<span className={styles.visuallyHidden}> {e.contentHash}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <MutationStatus error={paging.error} notice={null} />
            {cursor ? (
              <button type="button" disabled={paging.pending} onClick={() => void loadMore()}>
                Load more
              </button>
            ) : null}
          </>
        );
      }}
    </ResourceView>
  );
}
