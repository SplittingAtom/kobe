"use client";

import { ToolCardApp } from "../apps/tool-card-app";
import { useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { BanIcon, CheckIcon, CircleAlertIcon, ClockIcon, LoaderIcon } from "lucide-react";
import { REMEMBER_SCOPE_LABELS } from "@kobe/protocol";
import type { ComponentType } from "react";
import { formatDuration, inputSummary } from "../../lib/chat/history";
import type { ToolActivity } from "../../lib/chat/live";
import type { KobeMessageMeta } from "../../lib/chat/tree";
import { cn } from "../../lib/utils";
import { toneClass, type StatusTone } from "../ui/status";
import { ARTIFACT_TOOL_NAMES, artifactIdFromToolResult } from "../../lib/chat/artifacts";
import { OpenArtifactButton } from "./artifact-panel";
import { Disclosure, useDisclosure } from "./detail";
import { useKobeExtras } from "./kobe-runtime";
import { FullOutputStatus, Output, PRE, useFullOutput, type FullOutput } from "./tool-output";
import { useSkillOfToolCall } from "./skill-badge";
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

export type Outcome = "denied" | "error" | "done" | "waiting" | "running";

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

/**
 * The step's status colour (KOBE-301, app/theme.css): running green with a spinning icon,
 * waiting for approval amber, failed and denied red, done a muted green check. The label and
 * icon always show too.
 */
export const OUTCOME_TONE: Record<Outcome, StatusTone> = {
  denied: "failed",
  error: "failed",
  done: "done",
  waiting: "attention",
  running: "running",
};

/**
 * The tool's name chip (KOBE-374): gold (app/theme.css `--kobe-tool-badge*`), so tool use is
 * recognisable at a glance; the outcome colours stay on the step's icon and label.
 */
export const TOOL_BADGE =
  "border-tool-badge-border bg-tool-badge-bg text-tool-badge shrink-0 rounded-md border px-1.5 font-mono text-xs leading-5 font-medium";

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

/** The result entry of a call whose output the entry list trimmed (KOBE-208), if any. */
function useFullOutputEntry(toolCallId: string): string | undefined {
  return useAuiState((s) => {
    const meta = s.message.metadata.custom as KobeMessageMeta | undefined;
    return meta?.kind === "assistant" ? meta.fullOutputs?.[toolCallId] : undefined;
  });
}

/** The collapsed card: tool, one-line input, status and how long it took. */
function ToolCardHeader({
  toolName,
  summary,
  skill,
  outcome,
  took,
}: {
  readonly toolName: string;
  readonly summary: string;
  /** The skill this call loaded (KOBE-297): "Read skill <name>" instead of tool and path. */
  readonly skill?: string | undefined;
  readonly outcome: Outcome;
  readonly took: string | undefined;
}) {
  const Icon = OUTCOME_ICON[outcome];
  const tone = toneClass(OUTCOME_TONE[outcome]);
  return (
    <>
      <Icon
        aria-hidden
        data-kobe-outcome={outcome}
        className={cn(
          "size-4 shrink-0",
          outcome === "running" && "animate-spin motion-reduce:animate-none",
          tone,
        )}
      />
      {skill === undefined ? (
        <>
          <span data-kobe-tool-badge className={TOOL_BADGE}>
            {toolName}
          </span>
          {summary !== "" && <span className="min-w-0 truncate font-mono text-xs">{summary}</span>}
        </>
      ) : (
        <>
          <span data-kobe-tool-badge className={cn(TOOL_BADGE, "font-sans")}>
            Read skill
          </span>
          <span className="text-foreground min-w-0 truncate font-mono text-xs">{skill}</span>
        </>
      )}
      <span className={cn("ms-auto shrink-0", tone)} data-kobe-outcome-label={outcome}>
        {OUTCOME_LABEL[outcome]}
      </span>
      {took !== undefined && <span className="shrink-0 tabular-nums">{took}</span>}
    </>
  );
}

/** The open card: the full input and output (a trimmed output is read in full). */
function ToolCardBody({
  input,
  result,
  error,
  truncated,
  full,
  retry,
}: {
  readonly input: string;
  readonly result: string;
  readonly error: boolean;
  readonly truncated: boolean;
  /** Set when the entry list trimmed the output. */
  readonly full: FullOutput | undefined;
  retry(): void;
}) {
  return (
    <>
      <p className="text-muted-foreground m-0 text-xs font-medium">Input</p>
      <pre aria-label="Input" className={PRE}>
        {input}
      </pre>
      {full?.status === "ready" ? (
        <Output text={full.text} error={full.isError} truncated={full.truncated} />
      ) : (
        result !== "" && (
          <Output text={result} error={error} truncated={truncated || full !== undefined} />
        )
      )}
      {full && <FullOutputStatus output={full} retry={retry} />}
    </>
  );
}

/** What must not hide in the collapsed part: denials, blocked domains, approvals, artifacts. */
function ToolCardSlots({
  activity,
  toolName,
  result,
}: {
  readonly activity: ToolActivity;
  readonly toolName: string;
  readonly result: unknown;
}) {
  return (
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
      {activity.ruleApplied && (
        <p className={styles.notice} role="note">
          Allowed by your rule ({REMEMBER_SCOPE_LABELS[activity.ruleApplied.scope]}). You can revoke
          it in My area, Approvals.
        </p>
      )}
      {activity.egressBlocked.map((blocked) => (
        <EgressBlocked key={blocked.domain} payload={blocked} />
      ))}
      <ApprovalSlot tool={activity} />
      {activity.artifacts.map((artifact) => (
        <ArtifactSlot key={`${artifact.artifact_id}:${artifact.version}`} artifact={artifact} />
      ))}
      {activity.artifacts.length === 0 && ARTIFACT_TOOL_NAMES.has(toolName) && (
        <ReopenArtifact result={result} />
      )}
      {activity.files.map((file) => (
        <FileSlot key={file.file_id} file={file} />
      ))}
    </div>
  );
}

/**
 * A tool call and what happened to it (spec §5.3 "tool cards", CE12): collapsed to a header of
 * tool, one-line input, status and duration; open, the full input and output (one the entry
 * list trimmed is read in full then, KOBE-208). Approval, artifact and file slots are filled by
 * KOBE-37/55/54 (`slots.tsx`) and stay outside the collapsed part.
 */
export function ToolCallCard(props: ToolCallMessagePartProps) {
  const extras = useKobeExtras();
  const activity = extras?.state.live?.tools[props.toolCallId] ?? NO_ACTIVITY;
  const { open, setOpen } = useDisclosure();
  const fullEntry = useFullOutputEntry(props.toolCallId);
  const skill = useSkillOfToolCall(props.toolCallId)?.name;
  const { output: full, retry } = useFullOutput(fullEntry, open);
  const outcome = outcomeOf(activity, props);
  const timing = props.timing;
  const took =
    timing?.completedAt === undefined
      ? undefined
      : formatDuration(timing.completedAt - timing.startedAt);
  return (
    <section
      className="border-border bg-card text-card-foreground my-1 w-full rounded-lg border text-sm whitespace-normal"
      aria-label={`Tool call ${props.toolName}${skill === undefined ? "" : `: skill ${skill}`}`}
    >
      <Disclosure
        open={open}
        onOpenChange={setOpen}
        headerClassName="text-muted-foreground px-3 py-2"
        bodyClassName="border-border border-t px-4 pt-2 pb-3"
        summary={
          <ToolCardHeader
            toolName={props.toolName}
            summary={inputSummary((props.args ?? {}) as Readonly<Record<string, unknown>>)}
            skill={skill}
            outcome={outcome}
            took={took}
          />
        }
      >
        <ToolCardBody
          input={pretty(props.argsText, props.args)}
          result={resultText(props.result) || (activity.result?.preview ?? "")}
          error={outcome === "error"}
          truncated={props.result === undefined && activity.result?.truncated === true}
          full={fullEntry === undefined ? undefined : full}
          retry={retry}
        />
      </Disclosure>
      <ToolCardSlots
        activity={activity}
        toolName={props.toolName}
        result={props.result ?? activity.result?.preview}
      />
      {props.toolName.startsWith("mcp__") && (
        <ToolCardApp toolCallId={props.toolCallId} hasMarker={activity.result?.app !== undefined} />
      )}
    </section>
  );
}
