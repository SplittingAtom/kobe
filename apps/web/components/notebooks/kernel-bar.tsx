"use client";

/**
 * The kernel's controls and state (KOBE-465): Interrupt, Start until a kernel is up (KOBE-477:
 * wakes the sandbox and starts it, running nothing), then Restart (asks first: state is lost),
 * whether it is running something, what the last control did, why a run was refused, and the
 * egress notices of the member's own runs (NB17, the shell's notice).
 */
import { useSyncExternalStore } from "react";
import { ErrorNotice } from "../admin/error-notice";
import { EgressNotice } from "../chat/egress-notice";
import { BUTTON } from "../files/file-editor";
import { egressNotices, type Execution } from "../../lib/notebooks/executions";
import type { KernelNote, KernelPhase, KernelWiring } from "./use-kernel";

export const RESTART_PROMPT = "Restart the kernel? Its variables and imports are lost.";
export const READ_ONLY_NOTE =
  "You are viewing a shared conversation: only its owner can run code in its kernel.";
export const NO_THREAD_NOTE =
  "Send a message first: code runs in this conversation's kernel, in your sandbox.";

/** The kernel's state as the status line says it (KOBE-477: Start's steps first). */
function kernelState(phase: KernelPhase, busy: boolean, live: boolean) {
  if (phase === "waking") return { key: "waking", text: "Waking sandbox…" };
  if (phase === "starting") return { key: "starting", text: "Starting kernel…" };
  if (busy) return { key: "busy", text: "Kernel busy" };
  if (live) return { key: "idle", text: "Kernel idle" };
  if (phase === "stopped") return { key: "none", text: "No kernel" };
  return { key: "unknown", text: "" };
}

export function KernelControls({
  wiring,
  busy,
  live = busy,
  phase = "unknown",
  onStart,
  onKernel,
}: {
  readonly wiring: KernelWiring | undefined;
  readonly busy: boolean;
  /** A kernel is up (started, or used in this tab): Restart instead of Start. */
  readonly live?: boolean;
  readonly phase?: KernelPhase;
  onStart?(): void;
  onKernel(op: "interrupt" | "restart"): void;
}) {
  const ready = wiring !== undefined && wiring.threadId !== null;
  if (wiring?.readOnly) {
    return (
      <span
        role="status"
        className="text-muted-foreground text-xs"
        data-kobe-kernel={busy ? "busy" : "idle"}
      >
        {busy ? "Kernel busy" : "Kernel idle"}
      </span>
    );
  }
  const starting = phase === "waking" || phase === "starting";
  const state = kernelState(phase, busy, live);
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
      {live && !starting ? (
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
      ) : (
        <button
          type="button"
          className={BUTTON}
          disabled={!ready || starting || onStart === undefined}
          aria-busy={starting}
          onClick={() => onStart?.()}
        >
          Start
        </button>
      )}
      <span role="status" className="text-muted-foreground text-xs" data-kobe-kernel={state.key}>
        {state.text}
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
      {wiring?.readOnly === true && (
        <p role="note" className="text-muted-foreground text-xs">
          {READ_ONLY_NOTE}
        </p>
      )}
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
