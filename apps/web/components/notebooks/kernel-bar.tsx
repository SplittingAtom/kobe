"use client";

/**
 * The kernel's controls and state (KOBE-465): Interrupt, Restart (asks first: state is lost),
 * whether it is running something, what the last control did, why a run was refused, and the
 * egress notices of the member's own runs (NB17, the shell's notice).
 */
import { useSyncExternalStore } from "react";
import { ErrorNotice } from "../admin/error-notice";
import { EgressNotice } from "../chat/egress-notice";
import { BUTTON } from "../files/file-editor";
import { egressNotices, type Execution } from "../../lib/notebooks/executions";
import type { KernelNote, KernelWiring } from "./use-kernel";

export const RESTART_PROMPT = "Restart the kernel? Its variables and imports are lost.";
export const NO_THREAD_NOTE =
  "Send a message first: code runs in this conversation's kernel, in your sandbox.";

export function KernelControls({
  wiring,
  busy,
  onKernel,
}: {
  readonly wiring: KernelWiring | undefined;
  readonly busy: boolean;
  onKernel(op: "interrupt" | "restart"): void;
}) {
  const ready = wiring !== undefined && wiring.threadId !== null;
  return (
    <>
      <button
        type="button"
        className={BUTTON}
        disabled={!ready}
        onClick={() => onKernel("interrupt")}
      >
        Interrupt
      </button>
      <button
        type="button"
        className={BUTTON}
        disabled={!ready}
        onClick={() => {
          if (window.confirm(RESTART_PROMPT)) onKernel("restart");
        }}
      >
        Restart
      </button>
      <span
        role="status"
        className="text-muted-foreground text-xs"
        data-kobe-kernel={busy ? "busy" : "idle"}
      >
        {busy ? "Kernel busy" : "Kernel idle"}
      </span>
    </>
  );
}

const noSubscribe = () => () => {};
const noEgress = () => [];

export function KernelNotices({
  wiring,
  note,
  execs,
  path,
}: {
  readonly wiring: KernelWiring | undefined;
  readonly note: KernelNote;
  readonly execs: readonly Execution[];
  readonly path: string;
}) {
  const egress = useSyncExternalStore(
    wiring?.runs.subscribe ?? noSubscribe,
    wiring?.runs.egress ?? noEgress,
    wiring?.runs.egress ?? noEgress,
  );
  const threadId = wiring?.threadId ?? null;
  const blocked = threadId === null ? [] : egressNotices(execs, egress, threadId, path);
  return (
    <>
      {threadId === null && (
        <p role="note" className="text-muted-foreground text-xs">
          {NO_THREAD_NOTE}
        </p>
      )}
      {note.kind === "error" && <ErrorNotice error={note.error} />}
      {(note.kind === "working" || note.kind === "done") && (
        <p role="status" className="text-muted-foreground text-xs">
          {note.text}
        </p>
      )}
      {blocked.map((b) => (
        <EgressNotice
          key={`${b.runId}:${b.payload.domain}`}
          payload={b.payload}
          api={wiring?.egressApi}
          threadId={threadId ?? undefined}
        />
      ))}
    </>
  );
}
