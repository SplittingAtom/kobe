"use client";

/**
 * The kernel's controls and state (KOBE-465): Interrupt, Start until a kernel is up (KOBE-477:
 * wakes the sandbox and starts it, running nothing), then Restart (asks first: state is lost), as
 * actions of the file editor's toolbar (KOBE-615),
 * whether it is running something, what the last control did, why a run was refused, and the
 * egress notices of the member's own runs (NB17, the shell's notice).
 */
import { PowerIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { ErrorNotice } from "../admin/error-notice";
import { EgressNotice } from "../chat/egress-notice";
import type { ToolbarAction } from "../files/editor-toolbar";
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

export interface KernelControlProps {
  readonly wiring: KernelWiring | undefined;
  readonly busy: boolean;
  /** A kernel is up (started, or used in this tab): Restart instead of Start. */
  readonly live?: boolean;
  readonly phase?: KernelPhase;
  onStart?(): void;
  onKernel(op: "interrupt" | "restart"): void;
}

/** Why the kernel's controls are disabled, or undefined when they work. */
export function kernelBlocker(wiring: KernelWiring | undefined): string | undefined {
  if (wiring === undefined) return "Code runs in a conversation's kernel; open this file in one.";
  if (wiring.threadId === null) return NO_THREAD_NOTE;
  return undefined;
}

/**
 * Interrupt, then Start until a kernel is up (KOBE-477), then Restart (asks first), as toolbar
 * actions (KOBE-615); none for a shared reader, who only sees the state.
 */
export function kernelActions({
  wiring,
  live = false,
  phase = "unknown",
  onStart,
  onKernel,
}: KernelControlProps): ToolbarAction[] {
  if (wiring?.readOnly) return [];
  const reason = kernelBlocker(wiring);
  const ready = reason === undefined;
  const starting = phase === "waking" || phase === "starting";
  const interrupt: ToolbarAction = {
    id: "interrupt",
    label: "Interrupt",
    icon: SquareIcon,
    disabled: !ready,
    reason,
    onSelect: () => onKernel("interrupt"),
  };
  const second: ToolbarAction =
    live && !starting
      ? {
          id: "restart",
          label: "Restart",
          icon: RotateCcwIcon,
          disabled: !ready,
          reason,
          onSelect: () => {
            if (window.confirm(RESTART_PROMPT)) onKernel("restart");
          },
        }
      : {
          id: "start",
          label: "Start",
          icon: PowerIcon,
          disabled: !ready || starting || onStart === undefined,
          busy: starting,
          reason: reason ?? (starting ? "The kernel is starting." : undefined),
          onSelect: () => onStart?.(),
        };
  return [interrupt, second];
}

/** The kernel's state at the toolbar's end ("Kernel idle", "Waking sandbox…"). */
export function KernelState({
  wiring,
  busy,
  live = busy,
  phase = "unknown",
}: Pick<KernelControlProps, "wiring" | "busy" | "live" | "phase">) {
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
  const state = kernelState(phase, busy, live);
  return (
    <span role="status" className="text-muted-foreground text-xs" data-kobe-kernel={state.key}>
      {state.text}
    </span>
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
          blockedAt={b.blockedAt}
          api={wiring?.egressApi}
          threadId={threadId ?? undefined}
        />
      ))}
    </>
  );
}
