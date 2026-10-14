"use client";

import { useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { BanIcon, CheckIcon, CircleAlertIcon, ClockIcon, LoaderIcon } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { formatDuration, inputSummary, toolResultOf } from "../../lib/chat/history";
import type { ToolActivity } from "../../lib/chat/live";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { cn } from "../../lib/utils";
import { ARTIFACT_TOOL_NAMES, artifactIdFromToolResult } from "../../lib/chat/artifacts";
import { OpenArtifactButton } from "./artifact-panel";
import { Disclosure, useDisclosure } from "./detail";
import { useKobeExtras } from "./kobe-runtime";
import { ApprovalSlot, ArtifactSlot, EgressBlocked, FileSlot } from "./slots";
import styles from "./chat.module.css";

const NO_ACTIVITY: ToolActivity = { egressBlocked: [], artifacts: [], files: [] };

function pretty(argsText: string | undefined, args: unknown): string {
  try {
    return JSON.stringify(argsText ? JSON.parse(argsText) : args, null, 2);
  } catch {
    return argsText ?? "";
  }
}

function resultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

type Outcome = "denied" | "error" | "done" | "waiting" | "running";

function outcomeOf(
  activity: ToolActivity,
  props: ToolCallMessagePartProps,
  stored: Stored | undefined,
): Outcome {
  if (activity.denied) return "denied";
  const isError =
    props.isError ?? activity.result?.is_error ?? (stored?.status === "ready" && stored.isError);
  if (isError) return "error";
  if (props.result !== undefined || activity.result || stored) return "done";
  if (activity.approvalRequested && !activity.approvalResolved) return "waiting";
  return "running";
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  denied: "Denied by policy",
  error: "Failed",
  done: "Done",
  waiting: "Waiting for approval",
  running: "Running…",
};

const OUTCOME_ICON: Record<Outcome, ComponentType<{ className?: string }>> = {
  denied: BanIcon,
  error: CircleAlertIcon,
  done: CheckIcon,
  waiting: ClockIcon,
  running: LoaderIcon,
};

/** A finished artifact call in an old thread: no live event, so the id comes from the result. */
function ReopenArtifact({ result }: { readonly result: unknown }) {
  const id = artifactIdFromToolResult(result);
  if (id === undefined) return null;
  return (
    <p className={styles.notice}>
      Artifact
      <OpenArtifactButton id={id} title="from this tool call" />
    </p>
  );
}

/** A result over 64 KB, offloaded to object storage (D15): read back the first time it is shown. */
type Stored =
  | { readonly status: "idle" | "loading" | "failed" }
  | { readonly status: "ready"; readonly text: string; readonly isError: boolean };

function useStoredResult(toolCallId: string, open: boolean): Stored | undefined {
  const controller = useKobeExtras()?.controller;
  const entryId = useAuiState((s) => {
    const meta = s.message.metadata.custom as KobeMessageMeta | undefined;
    return meta?.kind === "assistant" ? meta.offloaded?.[toolCallId] : undefined;
  });
  const [stored, setStored] = useState<Stored>({ status: "idle" });
  const started = useRef(false);
  useEffect(() => {
    if (!open || entryId === undefined || !controller || started.current) return;
    started.current = true;
    setStored({ status: "loading" });
    const request = controller.entryBody(entryId);
    if (!request) {
      setStored({ status: "failed" });
      return;
    }
    void request.then((res) => {
      const result = res.ok ? toolResultOf(entryId, res.data.payload) : undefined;
      setStored(result ? { status: "ready", ...result } : { status: "failed" });
    });
  }, [open, entryId, controller]);
  return entryId === undefined ? undefined : stored;
}

const PRE =
  "bg-muted/50 my-1 max-h-64 overflow-auto rounded-md p-2 font-mono text-xs break-words whitespace-pre-wrap";

function Output({
  text,
  error,
  truncated,
}: {
  readonly text: string;
  readonly error: boolean;
  readonly truncated: boolean;
}) {
  return (
    <>
      <p className="text-muted-foreground m-0 text-xs font-medium">{error ? "Error" : "Output"}</p>
      <pre aria-label="Output" className={cn(PRE, error && "text-destructive")}>
        {text}
        {truncated ? "…" : ""}
      </pre>
    </>
  );
}

function StoredOutput({ stored }: { readonly stored: Stored }) {
  if (stored.status === "ready") {
    return <Output text={stored.text} error={stored.isError} truncated={false} />;
  }
  if (stored.status === "failed") {
    return (
      <p role="alert" className="text-destructive m-0 text-xs">
        This output is too large to show here and could not be loaded.
      </p>
    );
  }
  return (
    <p role="status" className="text-muted-foreground m-0 text-xs">
      Loading the full output…
    </p>
  );
}

/**
 * A tool call and what happened to it (spec §5.3 "tool cards", CE12): collapsed to a header of
 * tool, one-line input, status and duration; open, the full input and output (an offloaded output
 * is read back then, KOBE-208). A policy denial (`policy.denied`), blocked internet access
 * (`egress.blocked`), approvals and artifacts stay outside the collapsed part so they can't be
 * missed. Approval, artifact and file slots are filled by KOBE-37/55/54 (`slots.tsx`).
 */
export function ToolCallCard(props: ToolCallMessagePartProps) {
  const extras = useKobeExtras();
  const activity = extras?.state.live?.tools[props.toolCallId] ?? NO_ACTIVITY;
  const { open, setOpen } = useDisclosure();
  const stored = useStoredResult(props.toolCallId, open);
  const outcome = outcomeOf(activity, props, stored);
  const result = resultText(props.result) || (activity.result?.preview ?? "");
  const truncated = props.result === undefined && activity.result?.truncated === true;
  const summary = inputSummary((props.args ?? {}) as Readonly<Record<string, unknown>>);
  const took =
    props.timing?.completedAt === undefined
      ? undefined
      : formatDuration(props.timing.completedAt - props.timing.startedAt);

  const Icon = OUTCOME_ICON[outcome];
  const failed = outcome === "denied" || outcome === "error";

  return (
    <section
      className="border-border bg-card text-card-foreground my-1 w-full rounded-lg border text-sm whitespace-normal"
      aria-label={`Tool call ${props.toolName}`}
    >
      <Disclosure
        open={open}
        onOpenChange={setOpen}
        headerClassName="text-muted-foreground px-3 py-2"
        bodyClassName="border-border border-t px-4 pt-2 pb-3"
        summary={
          <>
            <Icon
              aria-hidden
              className={cn(
                "size-4 shrink-0",
                outcome === "running" && "animate-spin motion-reduce:animate-none",
                failed && "text-destructive",
              )}
            />
            <span className="text-foreground shrink-0 font-mono font-medium">{props.toolName}</span>
            {summary !== "" && (
              <span className="min-w-0 truncate font-mono text-xs">{summary}</span>
            )}
            <span className={cn("ms-auto shrink-0", failed && "text-destructive")}>
              {OUTCOME_LABEL[outcome]}
            </span>
            {took !== undefined && <span className="shrink-0 tabular-nums">{took}</span>}
          </>
        }
      >
        <p className="text-muted-foreground m-0 text-xs font-medium">Input</p>
        <pre aria-label="Input" className={PRE}>
          {pretty(props.argsText, props.args)}
        </pre>
        {result !== "" && (
          <Output text={result} error={outcome === "error"} truncated={truncated} />
        )}
        {result === "" && stored && <StoredOutput stored={stored} />}
      </Disclosure>
      <div className="px-4 pb-2 empty:hidden">
        {activity.denied && (
          <div className={styles.denied} role="note">
            <strong>Denied by policy.</strong> The tool did not run.
            <ul>
              {activity.denied.reasons.map((reason) => (
                <li key={`${reason.stage}:${reason.code}`}>{reason.message}</li>
              ))}
            </ul>
          </div>
        )}
        {activity.egressBlocked.map((blocked) => (
          <EgressBlocked key={blocked.domain} payload={blocked} />
        ))}
        <ApprovalSlot tool={activity} />
        {activity.artifacts.map((artifact) => (
          <ArtifactSlot key={`${artifact.artifact_id}:${artifact.version}`} artifact={artifact} />
        ))}
        {activity.artifacts.length === 0 && ARTIFACT_TOOL_NAMES.has(props.toolName) && (
          <ReopenArtifact result={props.result ?? activity.result?.preview} />
        )}
        {activity.files.map((file) => (
          <FileSlot key={file.file_id} file={file} />
        ))}
      </div>
    </section>
  );
}
