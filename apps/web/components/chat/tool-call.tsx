"use client";

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import {
  BanIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ClockIcon,
  LoaderIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import type { ToolActivity } from "../../lib/chat/live";
import { cn } from "../../lib/utils";
import { ARTIFACT_TOOL_NAMES, artifactIdFromToolResult } from "../../lib/chat/artifacts";
import { OpenArtifactButton } from "./artifact-panel";
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

function outcomeOf(activity: ToolActivity, props: ToolCallMessagePartProps): Outcome {
  if (activity.denied) return "denied";
  const isError = props.isError ?? activity.result?.is_error ?? false;
  if (isError) return "error";
  if (props.result !== undefined || activity.result) return "done";
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

/**
 * A tool call and what happened to it (spec §5.3 "tool cards"). A policy denial (`policy.denied`)
 * and blocked internet access (`egress.blocked`) are shown outside the collapsed details so they
 * can't be missed. Approval, artifact and file slots are filled by KOBE-37/55/54 (`slots.tsx`).
 */
export function ToolCallCard(props: ToolCallMessagePartProps) {
  const extras = useKobeExtras();
  const activity = extras?.state.live?.tools[props.toolCallId] ?? NO_ACTIVITY;
  const outcome = outcomeOf(activity, props);
  const result = resultText(props.result) || (activity.result?.preview ?? "");
  const truncated = props.result === undefined && activity.result?.truncated === true;
  const label = `${props.toolName}: ${OUTCOME_LABEL[outcome]}`;

  const Icon = OUTCOME_ICON[outcome];
  const failed = outcome === "denied" || outcome === "error";

  return (
    <section
      className="border-border bg-card text-card-foreground my-2 w-full rounded-lg border text-sm whitespace-normal"
      aria-label={`Tool call ${props.toolName}`}
    >
      <p className="flex items-center gap-2 px-4 pt-3 pb-1">
        <Icon
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            outcome === "running" && "animate-spin motion-reduce:animate-none",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        />
        <span className="font-mono font-medium">{props.toolName}</span>
        <span className="text-muted-foreground">·</span>
        <span className={failed ? "text-destructive" : "text-muted-foreground"}>
          {OUTCOME_LABEL[outcome]}
        </span>
      </p>
      <div className="px-4 pb-1 empty:hidden">
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
      </div>
      <details className="group border-border mt-1 border-t">
        <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1.5 px-4 py-2 select-none [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          />
          Details of {label}
        </summary>
        <div className="px-4 pb-3">
          <p className="text-muted-foreground text-xs font-medium">Input</p>
          <pre className="bg-muted/50 my-1 max-h-64 overflow-auto rounded-md p-2 font-mono text-xs break-words whitespace-pre-wrap">
            {pretty(props.argsText, props.args)}
          </pre>
          {result !== "" && (
            <>
              <p className="text-muted-foreground text-xs font-medium">
                {outcome === "error" ? "Error" : "Result"}
              </p>
              <pre
                className={cn(
                  "bg-muted/50 my-1 max-h-64 overflow-auto rounded-md p-2 font-mono text-xs break-words whitespace-pre-wrap",
                  outcome === "error" && "text-destructive",
                )}
              >
                {result}
                {truncated ? "…" : ""}
              </pre>
            </>
          )}
        </div>
      </details>
      <div className="px-4 pb-3 empty:hidden">
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
