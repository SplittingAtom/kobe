"use client";

import { useMemo, useState } from "react";
import {
  createMemoryApi,
  describeMemoryError,
  type MemoryApi,
  type MemoryDocSummary,
  type MemoryTarget,
} from "../../lib/memory/api";
import { visible } from "../../lib/security/visible";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
import styles from "../admin/admin.module.css";
import { MemoryDocView } from "./memory-doc";

/** Errors for people: the API's own wording, except where memory has better words. */
function friendly<T>(
  res: Awaited<ReturnType<MemoryApi["list"]>> | { ok: true; status: number; data: T },
) {
  return res.ok ? res : { ...res, error: { ...res.error, message: describeMemoryError(res.error) } };
}

/**
 * The memory files of one scope the person can see (`/v1/memory`, KOBE-155): list, open, edit,
 * delete, and version history. Everything shown is plain text (never HTML or markdown, so no
 * links or images from stored text), with hidden characters as visible escapes.
 */
export function MemoryPanel({
  teamId,
  target,
}: {
  readonly teamId: string;
  readonly target: MemoryTarget;
}) {
  const api = useMemo(() => createMemoryApi(teamId), [teamId]);
  const { state, reload } = useResource(async () => friendly(await api.list(target)));
  const [openId, setOpenId] = useState<string | null>(null);
  const mutation = useMutation();
  const title = target.scope === "project" ? "Project memory" : "My memory";

  return (
    <>
      <h1>{title}</h1>
      <p className={styles.hint}>
        What your agents remembered{target.scope === "project" ? " for this project" : " about you"}.
        Edit or delete anything you do not want kept. Agents treat this text as untrusted notes.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="memory">
        {(data) =>
          data.docs.length === 0 ? (
            <p>No memory files yet. Your agents add some when you ask them to remember something.</p>
          ) : (
            <DocList docs={data.docs} openId={openId} onOpen={setOpenId} />
          )
        }
      </ResourceView>
      {openId !== null && (
        <MemoryDocView
          key={openId}
          api={api}
          id={openId}
          target={target}
          mutation={mutation}
          onChanged={reload}
          onGone={() => {
            setOpenId(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function DocList({
  docs,
  openId,
  onOpen,
}: {
  readonly docs: readonly MemoryDocSummary[];
  readonly openId: string | null;
  readonly onOpen: (id: string) => void;
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Size</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id} aria-current={d.id === openId ? "true" : undefined}>
              <td>
                <button
                  type="button"
                  aria-label={`Open ${visible(d.path)}`}
                  onClick={() => onOpen(d.id)}
                >
                  {visible(d.path)}
                </button>
              </td>
              <td>{d.sizeBytes} bytes</td>
              <td>
                <DateTime value={d.updatedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
