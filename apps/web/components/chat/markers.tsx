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
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
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
  readonly approvals: ReadonlyMap<string, ApprovalMarker>;
}

const NO_MARKERS: MarkerData = { runsAt: new Map(), approvals: new Map() };
const MarkersContext = createContext<MarkerData>(NO_MARKERS);

export function ThreadMarkersProvider({ children }: { readonly children: ReactNode }) {
  const extras = useKobeExtras();
  const controller = extras?.controller;
  const threadId = extras?.state.threadId ?? null;
  const ended = extras?.state.live?.terminal ? extras.state.live.runId : null;
  const [read, setRead] = useState<{ threadId: string; markers: ThreadMarkers } | null>(null);
  useEffect(() => {
    if (!controller || threadId === null) return;
    let current = true;
    void controller.threadMarkers()?.then((res) => {
      if (current && res.ok) setRead({ threadId, markers: res.data });
    });
    return () => {
      current = false;
    };
  }, [controller, threadId, ended]);
  const markers = read !== null && read.threadId === threadId ? read.markers : null;
  const projection = extras?.projection;
  const value = useMemo((): MarkerData => {
    if (markers === null || !projection) return NO_MARKERS;
    return {
      runsAt: placeRunMarkers(markers.runs, projection),
      approvals: new Map(markers.approvals.map((a) => [a.toolCallId, a] as const)),
    };
  }, [markers, projection]);
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
  return (
    <MarkerRow kind="model" icon={CpuIcon}>
      Model changed to <span className="text-foreground font-medium">{marker.model}</span>
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

const APPROVAL: Record<ApprovalMarker["status"], { label: string; icon: LucideIcon }> = {
  allowed: { label: "Approval granted", icon: ShieldCheckIcon },
  denied: { label: "Approval denied", icon: ShieldXIcon },
  expired: { label: "Approval expired", icon: ShieldAlertIcon },
};

/** A tool card followed by its approval's outcome, when it needed one. */
export function withApprovalMarker(Card: (props: ToolCallMessagePartProps) => ReactNode) {
  return function ToolCallWithMarker(props: ToolCallMessagePartProps) {
    const approval = useContext(MarkersContext).approvals.get(props.toolCallId);
    const shown = approval ? APPROVAL[approval.status] : undefined;
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
