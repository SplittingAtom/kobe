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
import { DateTime, ResourceView } from "../admin/parts";
import { useResource, type Mutation } from "../admin/use-resource";
import { Button, Card, Textarea, eventTrigger, useConfirm } from "../ui/console";

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
    <section aria-label="Memory file" className="mt-6">
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
  const [confirm, confirmDialog] = useConfirm();
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
  async function remove(trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Delete ${shown}?`,
        description: "You can restore it from the history of a new write.",
        confirmLabel: "Delete",
      },
      trigger,
    );
    if (!yes) return;
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
    <Card>
      <h2 className="m-0 font-mono text-lg font-semibold break-all">{shown}</h2>
      <p className="m-0 mt-1 text-sm text-console-muted">
        Current version {doc.currentVersion}
        {current ? `, ${WRITTEN_BY[current.source]}` : ""}. Updated{" "}
        <DateTime value={doc.updatedAt} />.
      </p>
      {draft === null ? (
        <>
          <pre
            aria-label="Memory content"
            className="my-3 rounded-md border border-console-border bg-console-panel p-3 text-sm [overflow-wrap:anywhere] whitespace-pre-wrap"
          >
            {visible(doc.content)}
          </pre>
          {hasHidden(doc.content) && (
            <p className="text-sm text-console-muted">
              This file contains hidden characters, shown above as \uXXXX escapes.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={mutation.pending} onClick={() => setDraft(doc.content)}>
              Edit
            </Button>
            <Button
              variant="danger"
              disabled={mutation.pending}
              onClick={(e) => void remove(eventTrigger(e))}
            >
              Delete
            </Button>
          </div>
        </>
      ) : (
        <form
          aria-label={`Editing ${shown}`}
          className="my-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Textarea
            aria-label={`Edit ${shown}`}
            rows={12}
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full font-mono"
          />
          {hasHidden(draft) && (
            <p className="text-sm text-console-muted">
              This text contains hidden characters. They are kept when you save.
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={mutation.pending || draft === doc.content}
            >
              Save
            </Button>
            <Button disabled={mutation.pending} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <History
        versions={doc.versions}
        current={doc.currentVersion}
        pending={mutation.pending}
        onRestore={(v) => void restore(v)}
      />
      {confirmDialog}
    </Card>
  );
}

/** Turns a failed result's message into words for people. */
function explain<T>(
  res:
    | { ok: true; status: number; data: T }
    | { ok: false; error: { status: number; code: string; message: string } },
) {
  return res.ok
    ? res
    : { ...res, error: { ...res.error, message: describeMemoryError(res.error) } };
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
      <h3 className="m-0 mt-4 mb-2 text-base font-semibold">History</h3>
      <ul aria-label="Version history" className="m-0 flex list-none flex-col gap-1 p-0">
        {versions.map((v) => (
          <li key={v.version} className="flex flex-wrap items-center gap-x-2 text-sm">
            Version {v.version}, {WRITTEN_BY[v.source]}, <DateTime value={v.createdAt} />,{" "}
            {v.sizeBytes} bytes{" "}
            {v.version === current ? (
              "(current)"
            ) : (
              <Button
                size="sm"
                disabled={pending}
                aria-label={`Restore version ${v.version}`}
                onClick={() => onRestore(v.version)}
              >
                Restore
              </Button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
