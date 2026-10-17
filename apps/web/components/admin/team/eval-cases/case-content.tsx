"use client";

import type { EvalCaseContent } from "../../../../lib/admin/api/eval-cases";
import { REASON_LABELS } from "../../../../lib/chat/feedback";

function Block({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <div className="grid gap-1">
      <dt className="text-sm font-medium text-console-muted">{label}</dt>
      <dd className="m-0 box-border max-h-80 overflow-auto rounded-md border border-console-border bg-console-panel p-2 font-mono text-sm break-words whitespace-pre-wrap">
        {text === "" ? "(empty)" : text}
      </dd>
    </div>
  );
}

const sizeLabel = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * A shared case's copied exchange, exactly as stored, as plain text (React escapes it; nothing
 * is rendered as Markdown or HTML): earlier turns, the prompt, the answer, ticked tool outputs,
 * attached file names, the reasons and the comment.
 */
export function CaseContent({ content }: { readonly content: EvalCaseContent }) {
  return (
    <>
      <dl className="m-0 grid gap-3">
        {content.earlier.map((t, i) => (
          <Block
            key={`earlier-${i}`}
            label={t.role === "user" ? "Earlier prompt" : "Earlier answer"}
            text={t.text}
          />
        ))}
        <Block label="Prompt" text={content.prompt} />
        <Block label="The agent's answer" text={content.answer} />
        {content.toolOutputs.map((t, i) => (
          <Block
            key={`tool-${i}`}
            label={`Tool output: ${t.tool || "tool"}${t.isError ? " (error)" : ""}`}
            text={t.text}
          />
        ))}
        {content.attachments.length > 0 && (
          <Block
            label="Attached files (names only)"
            text={content.attachments
              .map((a) => `${a.name} (${a.mimeType}, ${sizeLabel(a.sizeBytes)})`)
              .join("\n")}
          />
        )}
        <div className="grid gap-1">
          <dt className="text-sm font-medium text-console-muted">Rating</dt>
          <dd className="m-0">
            Thumbs down
            {content.reasons.length > 0 &&
              `: ${content.reasons.map((r) => REASON_LABELS[r]).join(", ")}`}
          </dd>
        </div>
        {content.comment !== null && <Block label="Comment" text={content.comment} />}
      </dl>
      {content.truncated && (
        <p className="m-0 mt-2 text-sm text-console-muted">
          Some text was cut to the length limits when it was shared.
        </p>
      )}
    </>
  );
}
