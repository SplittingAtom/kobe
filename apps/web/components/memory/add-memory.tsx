"use client";

import { useState } from "react";
import type { MemoryItem, MemoryItemsApi } from "../../lib/memory/items-api";
import { visible } from "../../lib/security/visible";
import { Button, Card, Checkbox, useConfirm } from "../ui/console";
import { CheckProblem, useCheckedSave } from "./item-checks";
import { DraftFields, draftError, parseTags, type Draft } from "./item-fields";
import type { Done } from "./item-row";

const EMPTY: Draft = { statement: "", kind: "preference", tags: "" };

/**
 * Adds a memory to **This workspace**, or, for a preference only, to **All my workspaces** after
 * the 'Use in all my workspaces?' confirmation that shows the text (`confirm_portable`, SM6).
 */
export function AddMemory({
  api,
  known,
  onDone,
  onReload,
}: {
  readonly api: MemoryItemsApi;
  readonly known: ReadonlyMap<string, MemoryItem>;
  readonly onDone: (done: Done) => void;
  readonly onReload: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [everywhere, setEverywhere] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const { busy, problem, save, clear } = useCheckedSave();
  const portable = everywhere && draft.kind === "preference";

  const change = (next: Draft) => {
    setDraft(next);
    if (problem) clear();
  };

  async function submit(trigger: HTMLElement | null) {
    const bad = draftError(draft);
    setInvalid(bad);
    if (bad) return;
    if (portable) {
      const yes = await confirm(
        {
          title: "Use in all my workspaces?",
          description: (
            <>
              <span className="block">
                Kobe will use this preference in every workspace you belong to:
              </span>
              <span
                data-testid="portable-text"
                className="mt-2 block border-0 border-l-4 border-solid border-console-border ps-3 text-console-fg [overflow-wrap:anywhere] whitespace-pre-wrap"
              >
                {visible(draft.statement)}
              </span>
            </>
          ),
          confirmLabel: "Use in all my workspaces",
          tone: "primary",
        },
        trigger,
      );
      if (!yes) return;
    }
    const item = {
      scope: portable ? ("portable" as const) : ("user" as const),
      kind: draft.kind,
      statement: draft.statement,
      tags: parseTags(draft.tags),
    };
    await save(
      (o) => api.create(item, o),
      (saved) => {
        setDraft(EMPTY);
        setEverywhere(false);
        onDone({ message: "Memory saved.", undo: () => api.archive(saved) });
      },
    );
  }

  return (
    <Card title="Add a memory" level={2}>
      <form
        aria-label="Add a memory"
        onSubmit={(e) => {
          e.preventDefault();
          const submitter = (e.nativeEvent as SubmitEvent).submitter;
          void submit(submitter instanceof HTMLElement ? submitter : null);
        }}
      >
        <DraftFields draft={draft} onChange={change} label="New memory" />
        {draft.kind === "preference" && (
          <Checkbox
            className="mt-3"
            label="Use in all my workspaces"
            hint="Preferences can follow you into every workspace you belong to. Facts and other kinds stay in this workspace."
            checked={everywhere}
            onChange={(e) => setEverywhere(e.target.checked)}
          />
        )}
        {invalid && (
          <p role="alert" className="m-0 mt-2 text-sm text-status-failed">
            {invalid}
          </p>
        )}
        <div className="mt-3">
          <Button type="submit" variant="primary" disabled={busy}>
            Save memory
          </Button>
        </div>
      </form>
      {problem && <CheckProblem problem={problem} known={known} busy={busy} onReload={onReload} />}
      {confirmDialog}
    </Card>
  );
}
