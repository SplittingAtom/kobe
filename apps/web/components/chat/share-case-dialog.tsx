"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Dialog } from "radix-ui";
import { REASON_LABELS } from "../../lib/chat/feedback";
import {
  NO_EXTRAS,
  type EvalCaseContent,
  type EvalCaseOptions,
  type EvalCasePreview,
} from "../../lib/chat/eval-cases";
import { Button } from "../ui/button";
import { chatPortalContainer } from "../ui/chat-portal";
import { useKobeExtras } from "./kobe-runtime";

/**
 * "Share as an eval case" (KOBE-276): the preview of exactly what the agent's owner gets, from a
 * thumbs down on your own conversation. Nothing is shared until Share: the server stores the copy
 * only with this preview's digest. Earlier turns, tool outputs and file names are added only when
 * ticked; the owner never sees who shared it, and withdrawing deletes the copy.
 */
export function ShareCaseDialog({
  runId,
  onShared,
  onOpenChange,
}: {
  readonly runId: string;
  readonly onShared: (caseId: string) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const controller = useKobeExtras()?.controller;
  const [options, setOptions] = useState<EvalCaseOptions>(NO_EXTRAS);
  const [preview, setPreview] = useState<EvalCasePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next: EvalCaseOptions) => {
      if (!controller) return;
      setLoading(true);
      const res = await controller.previewEvalCase(runId, next);
      setLoading(false);
      if (res.ok) {
        setPreview(res.data);
        setError(null);
      } else {
        setPreview(null);
        setError(res.error.message);
      }
    },
    [controller, runId],
  );

  useEffect(() => {
    void load(options);
  }, [load, options]);

  async function share() {
    if (!controller || !preview || sharing) return;
    setSharing(true);
    const res = await controller.shareEvalCase(runId, options, preview.digest);
    setSharing(false);
    if (res.ok) {
      onShared(res.data.id);
      onOpenChange(false);
      return;
    }
    setError(res.error.message);
    // What would be shared changed (the rating was edited meanwhile): show it again.
    if (res.error.code === "preview_stale") void load(options);
  }

  const toggle = (key: "toolOutputIds" | "attachmentIds", id: string) =>
    setOptions((o) => ({
      ...o,
      [key]: o[key].includes(id) ? o[key].filter((x) => x !== id) : [...o[key], id],
    }));

  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal container={chatPortalContainer()}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" data-kobe-portal />
        <Dialog.Content
          className="bg-background text-foreground fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100vh-2rem)] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto rounded-lg border p-5 shadow-lg"
          data-share-case-dialog
          data-kobe-portal
        >
          <Dialog.Title className="m-0 text-base font-semibold">Share as an eval case</Dialog.Title>
          <Dialog.Description className="text-muted-foreground m-0 text-sm">
            The agent&apos;s owner gets exactly what is shown below, without your name, and can test
            the agent&apos;s next version against it. What it says may still identify you. You can
            withdraw it at any time; clearing your rating doesn&apos;t withdraw it.
          </Dialog.Description>
          {preview && (
            <Extras preview={preview} options={options} setOptions={setOptions} toggle={toggle} />
          )}
          <section aria-label="What will be shared" aria-busy={loading} className="grid gap-2">
            {preview ? (
              <CaseContent content={preview.content} />
            ) : loading ? (
              <p className="text-muted-foreground m-0 text-sm">Loading the preview…</p>
            ) : null}
          </section>
          {error !== null && (
            <p role="alert" className="text-destructive m-0 text-sm">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              type="button"
              disabled={!preview || loading || sharing || preview.sharedCaseId !== null}
              onClick={() => void share()}
            >
              {sharing ? "Sharing…" : "Share"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The ticks: earlier exchanges, this answer's tool outputs, the prompt's files (all off). */
function Extras({
  preview,
  options,
  setOptions,
  toggle,
}: {
  readonly preview: EvalCasePreview;
  readonly options: EvalCaseOptions;
  readonly setOptions: (update: (o: EvalCaseOptions) => EvalCaseOptions) => void;
  readonly toggle: (key: "toolOutputIds" | "attachmentIds", id: string) => void;
}) {
  const earlierId = useId();
  const { available } = preview;
  if (
    available.earlierExchanges === 0 &&
    available.toolOutputs.length === 0 &&
    available.attachments.length === 0
  ) {
    return null;
  }
  return (
    <fieldset className="grid gap-1.5 rounded-md border p-3 text-sm">
      <legend className="px-1 text-xs font-medium">Also include (off unless you tick it)</legend>
      {available.earlierExchanges > 0 && (
        <label htmlFor={earlierId} className="flex items-center gap-2">
          <span>Earlier exchanges</span>
          <select
            id={earlierId}
            className="border-input rounded-md border px-1 py-0.5"
            value={options.earlierExchanges}
            onChange={(e) => {
              const earlierExchanges = Number(e.target.value);
              setOptions((o) => ({ ...o, earlierExchanges }));
            }}
          >
            {Array.from({ length: available.earlierExchanges + 1 }, (_, n) => (
              <option key={n} value={n}>
                {n === 0 ? "None" : String(n)}
              </option>
            ))}
          </select>
        </label>
      )}
      {available.toolOutputs.map((t, i) => (
        <label key={t.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={options.toolOutputIds.includes(t.id)}
            onChange={() => toggle("toolOutputIds", t.id)}
          />
          <span>
            Tool output {i + 1}: {t.tool || "tool"}
            {t.isError ? " (error)" : ""}
          </span>
        </label>
      ))}
      {available.attachments.map((a) => (
        <label key={a.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={options.attachmentIds.includes(a.id)}
            onChange={() => toggle("attachmentIds", a.id)}
          />
          <span>File name: {a.name} (the file itself is never shared)</span>
        </label>
      ))}
    </fieldset>
  );
}

function Block({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <p className="bg-muted/40 m-0 rounded-md px-2 py-1.5 text-sm break-words whitespace-pre-wrap">
        {text}
      </p>
    </div>
  );
}

/** The copy as plain text (never rendered as Markdown or HTML). */
function CaseContent({ content }: { readonly content: EvalCaseContent }) {
  return (
    <>
      {content.earlier.map((t, i) => (
        <Block
          key={i}
          label={t.role === "user" ? "Earlier prompt" : "Earlier answer"}
          text={t.text}
        />
      ))}
      <Block label="Your prompt" text={content.prompt} />
      <Block label="The answer" text={content.answer} />
      {content.toolOutputs.map((t, i) => (
        <Block key={i} label={`Tool output: ${t.tool || "tool"}`} text={t.text} />
      ))}
      {content.attachments.length > 0 && (
        <Block label="File names" text={content.attachments.map((a) => a.name).join(", ")} />
      )}
      <Block
        label="Your rating"
        text={[
          "Thumbs down",
          content.reasons.length > 0
            ? content.reasons.map((r) => REASON_LABELS[r]).join(", ")
            : null,
          content.comment,
        ]
          .filter((x): x is string => x !== null && x !== "")
          .join(" · ")}
      />
      {content.truncated && (
        <p className="text-muted-foreground m-0 text-xs">
          Long text was shortened, or a very large part left out.
        </p>
      )}
    </>
  );
}
