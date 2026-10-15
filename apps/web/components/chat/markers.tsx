"use client";

import {
  BranchPickerPrimitive,
  useAuiState,
  type DataMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  CpuIcon,
  FoldVerticalIcon,
  GitForkIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  UnplugIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  approvalKey,
  placeRunMarkers,
  type ApprovalMarker,
  type EntryMarker,
  type RunMarker,
  type ThreadMarkers,
} from "../../lib/chat/markers";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { cn } from "../../lib/utils";
import { IconAction } from "../shell/icon-action";
import { Disclosure, useDisclosure } from "./detail";
import { useKobeExtras } from "./kobe-runtime";
import { Markdown } from "./markdown";

/**
 * Inline system markers (KOBE-209, CE12/CE16): a thin row between messages for each thing that is
 * not a conversation turn. Entry markers come with the message (`tree.ts`); run and approval
 * outcomes from `GET /v1/threads/{id}/markers`, read when the thread opens and after each run.
 */
interface MarkerData {
  readonly runsAt: ReadonlyMap<string, readonly RunMarker[]>;
  /** By {@link approvalKey}: tool call ids are only unique within a run. */
  readonly approvals: ReadonlyMap<string, ApprovalMarker>;
}

const NO_RUNS: ReadonlyMap<string, readonly RunMarker[]> = new Map();
const NO_APPROVALS: ReadonlyMap<string, ApprovalMarker> = new Map();
const MarkersContext = createContext<MarkerData>({ runsAt: NO_RUNS, approvals: NO_APPROVALS });

/** A failed read is tried once more after this; then the markers wait for the next trigger. */
const RETRY_MS = 500;

/** Calls `read` when `value` changes to something set (not on mount, not when it clears). */
function useOnSet(value: string | null, read: () => void) {
  const last = useRef(value);
  useEffect(() => {
    if (value === last.current) return;
    last.current = value;
    if (value !== null && value !== "") read();
  }, [value, read]);
}

/** What makes the markers stale: a run ended, an approval was decided, a run was interrupted. */
function useTriggers() {
  const state = useKobeExtras()?.state;
  const live = state?.live;
  return {
    ended: live?.terminal ? live.runId : null,
    decided: live
      ? Object.values(live.tools)
          .flatMap((t) => (t.approvalResolved ? [t.approvalResolved.approval_id] : []))
          .join(",")
      : null,
    interrupted: state?.interruptedRun?.runId ?? null,
  };
}

/** The thread's markers: read on open and on each trigger, retried once when a read fails. */
function useThreadMarkers(): ThreadMarkers | null {
  const extras = useKobeExtras();
  const controller = extras?.controller;
  const threadId = extras?.state.threadId ?? null;
  const [read, setRead] = useState<{ threadId: string; markers: ThreadMarkers } | null>(null);
  const latest = useRef(0);
  const load = useCallback(() => {
    if (!controller || threadId === null) return;
    latest.current += 1;
    const ticket = latest.current;
    const attempt = async (retry: boolean): Promise<void> => {
      const res = await controller.threadMarkers();
      if (!res || ticket !== latest.current) return;
      if (res.ok) {
        setRead({ threadId, markers: res.data });
      } else if (retry) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        if (ticket === latest.current) await attempt(false);
      } else {
        // Markers are a nicety: the conversation stays usable; the next trigger reads again.
        console.warn("Inline markers could not be read", res.error);
      }
    };
    void attempt(true);
  }, [controller, threadId]);
  useEffect(load, [load]);
  const { ended, decided, interrupted } = useTriggers();
  useOnSet(ended, load);
  useOnSet(decided, load);
  useOnSet(interrupted, load);
  return read !== null && read.threadId === threadId ? read.markers : null;
}

function samePlacement(
  a: ReadonlyMap<string, readonly RunMarker[]>,
  b: ReadonlyMap<string, readonly RunMarker[]>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, runs] of a) {
    const other = b.get(id);
    if (!other || other.length !== runs.length || runs.some((r, i) => r !== other[i])) {
      return false;
    }
  }
  return true;
}

export function ThreadMarkersProvider({ children }: { readonly children: ReactNode }) {
  const markers = useThreadMarkers();
  const projection = useKobeExtras()?.projection;
  const approvals = useMemo(
    () =>
      markers === null
        ? NO_APPROVALS
        : new Map(markers.approvals.map((a) => [approvalKey(a.userEntryId, a.toolCallId), a])),
    [markers],
  );
  // The projection changes with every streamed token; keep the placement while it is the same.
  const placed = useRef(NO_RUNS);
  const next =
    markers === null || !projection ? NO_RUNS : placeRunMarkers(markers.runs, projection);
  if (!samePlacement(placed.current, next)) placed.current = next;
  const runsAt = placed.current;
  const value = useMemo(() => ({ runsAt, approvals }), [runsAt, approvals]);
  return <MarkersContext.Provider value={value}>{children}</MarkersContext.Provider>;
}

/** The thin row: a rule on each side of an icon and a short label. */
function MarkerRow({
  kind,
  icon: Icon,
  tone,
  children,
}: {
  readonly kind: string;
  readonly icon: LucideIcon;
  readonly tone?: "warn" | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="note"
      data-kobe-marker={kind}
      className={cn(
        "text-muted-foreground flex min-w-0 items-center gap-2 px-2 py-0.5 text-xs",
        tone === "warn" && "text-amber-700 dark:text-amber-400",
      )}
    >
      <span aria-hidden className="bg-border h-px min-w-4 flex-1" />
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">{children}</span>
      <span aria-hidden className="bg-border h-px min-w-4 flex-1" />
    </div>
  );
}

function CompactionMarker({ marker }: { readonly marker: EntryMarker & { kind: "compaction" } }) {
  const { open, setOpen } = useDisclosure();
  const { folded, summary } = marker;
  return (
    <div data-kobe-marker="compaction" role="note" className="text-muted-foreground text-xs">
      <Disclosure
        open={open}
        onOpenChange={setOpen}
        className="flex flex-col items-center"
        headerClassName="w-auto"
        bodyClassName="border-border m-2 self-stretch rounded-lg border px-3 py-2 text-sm"
        summary={
          <>
            <FoldVerticalIcon aria-hidden className="size-3.5 shrink-0" />
            <span>Context compacted</span>
          </>
        }
      >
        {folded !== undefined && (
          <p className="m-0 mb-1 text-xs">
            {folded} earlier {folded === 1 ? "message" : "messages"} folded into this summary
          </p>
        )}
        {summary === "" ? (
          <p className="m-0">The summary is too large to show here.</p>
        ) : (
          <div className="text-foreground" data-kobe-summary>
            <Markdown text={summary} />
          </div>
        )}
      </Disclosure>
    </div>
  );
}

export function EntryMarkerRow({ marker }: { readonly marker: EntryMarker }) {
  if (marker.kind === "compaction") return <CompactionMarker marker={marker} />;
  // The branch's first model is the one it started on, not a change (KOBE-280).
  return (
    <MarkerRow kind="model" icon={CpuIcon}>
      {marker.first ? "Model:" : "Model changed to"}{" "}
      <span className="text-foreground font-medium">{marker.model}</span>
    </MarkerRow>
  );
}

/** An entry marker inside a turn (a `data-kobe-marker` part). */
export function MarkerPart({ data }: DataMessagePartProps) {
  const marker = data as EntryMarker | undefined;
  return marker?.kind === "model" || marker?.kind === "compaction" ? (
    <EntryMarkerRow marker={marker} />
  ) : null;
}

function RunMarkerRow({ run }: { readonly run: RunMarker }) {
  return run.status === "interrupted" ? (
    <MarkerRow kind="run" icon={UnplugIcon} tone="warn">
      Run interrupted
    </MarkerRow>
  ) : (
    <MarkerRow kind="budget" icon={WalletIcon} tone="warn">
      Run stopped by the budget
    </MarkerRow>
  );
}

/** Why an approval that nobody decided ended: the run's end, or its hour ran out (D29). */
const ENDED_BY: Partial<Record<NonNullable<ApprovalMarker["cause"]>, string>> = {
  run_cancelled: "Approval ended: run stopped",
  run_interrupted: "Approval ended: run interrupted",
  budget_exhausted: "Approval ended: budget reached",
  run_failed: "Approval ended: run failed",
};

function approvalLabel(approval: ApprovalMarker): { label: string; icon: LucideIcon } {
  if (approval.status === "allowed") return { label: "Approval granted", icon: ShieldCheckIcon };
  if (approval.status === "denied") return { label: "Approval denied", icon: ShieldXIcon };
  const ended = approval.cause === null ? undefined : ENDED_BY[approval.cause];
  return { label: ended ?? "Approval expired", icon: ShieldAlertIcon };
}

/** A tool card followed by its approval's outcome, when it needed one. */
export function withApprovalMarker(Card: (props: ToolCallMessagePartProps) => ReactNode) {
  return function ToolCallWithMarker(props: ToolCallMessagePartProps) {
    const prompt = useAuiState((s) => {
      const meta = s.message.metadata.custom as KobeMessageMeta | undefined;
      return meta?.kind === "assistant" ? meta.promptEntryId : undefined;
    });
    const approval = useContext(MarkersContext).approvals.get(
      approvalKey(prompt, props.toolCallId),
    );
    const shown = approval ? approvalLabel(approval) : undefined;
    return (
      <>
        <Card {...props} />
        {shown && (
          <MarkerRow
            kind="approval"
            icon={shown.icon}
            tone={approval?.status === "allowed" ? undefined : "warn"}
          >
            {shown.label}
          </MarkerRow>
        )}
      </>
    );
  };
}

/** Assistant-ui's branch picker: "Version n of m" between previous and next. */
export function BranchPicker({ className }: { readonly className?: string }) {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn("text-muted-foreground inline-flex items-center text-xs", className)}
    >
      <BranchPickerPrimitive.Previous asChild>
        <IconAction command="previous-branch" size="sm" />
      </BranchPickerPrimitive.Previous>
      <span className="font-medium">
        Version <BranchPickerPrimitive.Number /> of <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <IconAction command="next-branch" size="sm" />
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}

/** "Forked here": above a message that has other versions, with the picker inline. */
function ForkMarker() {
  const count = useAuiState((s) => s.message.branchCount);
  if (count < 2) return null;
  return (
    <MarkerRow kind="fork" icon={GitForkIcon}>
      <span>Forked here · {count} branches</span>
      <BranchPicker />
    </MarkerRow>
  );
}

/**
 * The markers above (the fork, then those carried below it) or after (how its run ended, then the
 * entries Pi wrote after it, which belong to the next run) the message in context.
 */
export function MessageMarkers({
  place,
  className,
}: {
  readonly place: "before" | "after";
  readonly className?: string;
}) {
  const meta = useAuiState((s) => s.message.metadata.custom as KobeMessageMeta | undefined);
  const id = useAuiState((s) => s.message.id);
  const runs = useContext(MarkersContext).runsAt.get(id);
  const entries = place === "before" ? meta?.before : meta?.after;
  return (
    <div className={cn("flex flex-col gap-1 empty:hidden", className)}>
      {place === "before" && <ForkMarker />}
      {place === "after" && runs?.map((run) => <RunMarkerRow key={run.runId} run={run} />)}
      {entries?.map((marker) => (
        <EntryMarkerRow key={marker.entryId} marker={marker} />
      ))}
    </div>
  );
}
