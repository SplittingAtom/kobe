"use client";

/**
 * The "Memory updated" chip for `memory.updated` (KOBE-158, D24) with Undo: restores the prior
 * version (history is kept), or deletes the doc when the write created it. The path comes from the
 * agent, so it is shown as plain text with invisible characters escaped, never as markup.
 */
import { useContext, useState } from "react";
import { undoMemoryAction, type KobeEventPayload } from "@kobe/protocol";
import { describeMemoryError } from "../../lib/memory/api";
import { visible } from "../../lib/security/visible";
import { ChatSessionContext } from "./kobe-runtime";
import styles from "./chat.module.css";

type Updated = KobeEventPayload<"memory.updated">;
type Phase = "idle" | "busy" | "undone";

export function MemoryNotice({ payload }: { readonly payload: Updated }) {
  const api = useContext(ChatSessionContext)?.api;
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const undo = undoMemoryAction(payload);

  const onUndo = async () => {
    if (!api) return;
    setPhase("busy");
    setError(null);
    const res = await api.undoMemory(payload.memory_doc_id, undo);
    if (res.ok) return setPhase("undone");
    setPhase("idle");
    setError(describeMemoryError(res.error));
  };

  return (
    <p className={styles.notice}>
      Memory updated: <span className={styles.toolName}>{visible(payload.path)}</span> (
      {payload.scope === "project" ? "project" : "personal"} memory)
      {phase === "undone" ? (
        <span role="status"> Undone.</span>
      ) : (
        <>
          {" "}
          <button
            type="button"
            aria-label={`Undo memory update ${visible(payload.path)}`}
            disabled={phase === "busy" || !api}
            onClick={() => void onUndo()}
          >
            {phase === "busy" ? "Undoing…" : "Undo"}
          </button>
        </>
      )}
      {error && (
        <span role="alert" className={styles.errorText}>
          {" "}
          {error}
        </span>
      )}
    </p>
  );
}
