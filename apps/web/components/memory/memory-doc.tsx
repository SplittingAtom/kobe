"use client";

import { useState } from "react";
import {
  describeMemoryError,
  type MemoryApi,
  type MemoryDocDetail,
  type MemoryTarget,
  type MemoryVersionInfo,
  type MemoryVersionSource,
} from "../../lib/memory/api";
import { visible } from "../../lib/security/visible";
import { DateTime, ResourceView, confirmed } from "../admin/parts";
import { useResource, type Mutation } from "../admin/use-resource";
import styles from "../admin/admin.module.css";

/** Provenance of a version, from the API's `source`. */
const WRITTEN_BY: Record<MemoryVersionSource, string> = {
  agent: "written by the agent",
  approval: "written by the agent and approved by a person",
  panel: "edited in the panel",
  restore: "restored from an earlier version",
};

/** Characters that are not shown as such (controls, bidi, zero-width): worth a warning. */
const hasHidden = (text: string) => visible(text) !== text;

export function MemoryDocView({
  api,
  id,
  target,
  mutation,
  onChanged,
  onGone,
}: {
  readonly api: MemoryApi;
  readonly id: string;
  readonly target: MemoryTarget;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
  readonly onGone: () => void;
}) {
  const { state, reload } = useResource(() => api.get(id));
  return (
    <section aria-label="Memory file" className={styles.form}>
      <ResourceView state={state} label="file">
        {(doc) => (
          <Loaded
            key={doc.currentVersion}
            api={api}
            doc={doc}
            target={target}
            mutation={mutation}
            onChanged={() => {
              reload();
              onChanged();
            }}
            onGone={onGone}
          />
        )}
      </ResourceView>
    </section>
  );
}

function Loaded({
  api,
  doc,
  target,
  mutation,
  onChanged,
  onGone,
}: {
  readonly api: MemoryApi;
  readonly doc: MemoryDocDetail;
  readonly target: MemoryTarget;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
  readonly onGone: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const current = doc.versions.find((v) => v.version === doc.currentVersion);
  const shown = visible(doc.path);

  async function save() {
    if (draft === null) return;
    const done = await mutation.run(
      async () => explain(await api.put(target, doc.path, draft, doc.currentVersion)),
      () => "Saved.",
    );
    if (done) onChanged();
  }
  async function remove() {
    if (!confirmed(`Delete ${shown}? You can restore it from the history of a new write.`)) return;
    const done = await mutation.run(
      async () => explain(await api.remove(doc.id)),
      () => "Deleted.",
    );
    if (done) onGone();
  }
  async function restore(version: number) {
    const done = await mutation.run(
      async () => explain(await api.restore(doc.id, version)),
      () => "Restored.",
    );
    if (done) onChanged();
  }

  return (
    <>
      <h2>{shown}</h2>
      <p className={styles.hint}>
        Current version {doc.currentVersion}
        {current ? `, ${WRITTEN_BY[current.source]}` : ""}. Updated <DateTime value={doc.updatedAt} />.
      </p>
      {draft === null ? (
        <>
          <pre aria-label="Memory content" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {visible(doc.content)}
          </pre>
          {hasHidden(doc.content) && (
            <p className={styles.hint}>
              This file contains hidden characters, shown above as \uXXXX escapes.
            </p>
          )}
          <p>
            <button type="button" disabled={mutation.pending} onClick={() => setDraft(doc.content)}>
              Edit
            </button>{" "}
            <button type="button" disabled={mutation.pending} onClick={() => void remove()}>
              Delete
            </button>
          </p>
        </>
      ) : (
        <form
          aria-label={`Editing ${shown}`}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            <textarea
              aria-label={`Edit ${shown}`}
              rows={12}
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{ width: "100%", fontFamily: "monospace" }}
            />
          </label>
          {hasHidden(draft) && (
            <p className={styles.hint}>
              This text contains hidden characters. They are kept when you save.
            </p>
          )}
          <button type="submit" disabled={mutation.pending || draft === doc.content}>
            Save
          </button>{" "}
          <button type="button" disabled={mutation.pending} onClick={() => setDraft(null)}>
            Cancel
          </button>
        </form>
      )}
      <History
        versions={doc.versions}
        current={doc.currentVersion}
        pending={mutation.pending}
        onRestore={(v) => void restore(v)}
      />
    </>
  );
}

/** Turns a failed result's message into words for people. */
function explain<T>(
  res: { ok: true; status: number; data: T } | { ok: false; error: { status: number; code: string; message: string } },
) {
  return res.ok ? res : { ...res, error: { ...res.error, message: describeMemoryError(res.error) } };
}

function History({
  versions,
  current,
  pending,
  onRestore,
}: {
  readonly versions: readonly MemoryVersionInfo[];
  readonly current: number;
  readonly pending: boolean;
  readonly onRestore: (version: number) => void;
}) {
  return (
    <>
      <h3>History</h3>
      <ul aria-label="Version history">
        {versions.map((v) => (
          <li key={v.version}>
            Version {v.version}, {WRITTEN_BY[v.source]}, <DateTime value={v.createdAt} />,{" "}
            {v.sizeBytes} bytes{" "}
            {v.version === current ? (
              "(current)"
            ) : (
              <button
                type="button"
                disabled={pending}
                aria-label={`Restore version ${v.version}`}
                onClick={() => onRestore(v.version)}
              >
                Restore
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
