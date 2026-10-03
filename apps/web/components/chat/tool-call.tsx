"use client";

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { ToolActivity } from "../../lib/chat/live";
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

  return (
    <section className={styles.tool} aria-label={`Tool call ${props.toolName}`}>
      <p className={styles.who}>
        <span className={styles.toolName}>{props.toolName}</span> ·{" "}
        <span
          className={outcome === "denied" || outcome === "error" ? styles.errorText : undefined}
        >
          {OUTCOME_LABEL[outcome]}
        </span>
      </p>
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
      <details>
        <summary>Details of {label}</summary>
        <p className={styles.who}>Input</p>
        <pre className={styles.toolPre}>{pretty(props.argsText, props.args)}</pre>
        {result !== "" && (
          <>
            <p className={styles.who}>{outcome === "error" ? "Error" : "Result"}</p>
            <pre className={`${styles.toolPre} ${outcome === "error" ? styles.errorText : ""}`}>
              {result}
              {truncated ? "…" : ""}
            </pre>
          </>
        )}
      </details>
      {activity.artifacts.map((artifact) => (
        <ArtifactSlot key={`${artifact.artifact_id}:${artifact.version}`} artifact={artifact} />
      ))}
      {activity.files.map((file) => (
        <FileSlot key={file.file_id} file={file} />
      ))}
    </section>
  );
}
