"use client";

import { SEMANTIC_MEMORY_SCOPE_LABELS } from "@kobe/protocol";
import { useState } from "react";
import type { MemoryItem, MemoryItemsApi } from "../../lib/memory/items-api";
import { Button, Card, Checkbox } from "../ui/console";
import { CheckProblem, useCheckedSave } from "./item-checks";
import { DraftFields, draftError, parseTags, type Draft } from "./item-fields";
import type { Done } from "./item-row";

const EMPTY: Draft = { statement: "", kind: "fact", tags: "" };

/**
 * Adds a Workspace or Site memory (KOBE-385) through the KOBE-379 save checks, with Save anyway
 * for warnings. Site admins may save it as Policy (always given to every agent).
 */
export function CuratorAdd({
  api,
  scope,
  canSetPolicy,
  known,
  onSaved,
  onReload,
}: {
  readonly api: MemoryItemsApi;
  readonly scope: "team" | "site";
  readonly canSetPolicy: boolean;
  readonly known: ReadonlyMap<string, MemoryItem>;
  readonly onSaved: (item: MemoryItem, done: Done) => void;
  readonly onReload: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [policy, setPolicy] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, problem, save, clear } = useCheckedSave();
  const label = SEMANTIC_MEMORY_SCOPE_LABELS[scope];
  const asPolicy = scope === "site" && canSetPolicy && policy;

  const submit = () => {
    const bad = draftError(draft);
    setInvalid(bad);
    if (bad) return;
    void save(
      (o) =>
        api.create(
          {
            scope,
            kind: draft.kind,
            statement: draft.statement,
            tags: parseTags(draft.tags),
            ...(asPolicy ? { policy: true } : {}),
          },
          o,
        ),
      (saved) => {
        setDraft(EMPTY);
        setPolicy(false);
        onSaved(saved, { message: "Memory saved.", undo: () => api.archive(saved) });
      },
    );
  };

  return (
    <Card title={`Add to ${label}`} level={2}>
      <form
        aria-label={`Add to ${label}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DraftFields
          draft={draft}
          onChange={(next) => {
            setDraft(next);
            if (problem) clear();
          }}
          label="New memory"
        />
        {scope === "site" && canSetPolicy && (
          <Checkbox
            className="mt-3"
            label="Policy"
            hint="Policy is given to every agent in every workspace, always, and can't be pinned. At most 25 items and 2 KiB."
            checked={policy}
            onChange={(e) => {
              setPolicy(e.target.checked);
              if (problem) clear();
            }}
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
    </Card>
  );
}
