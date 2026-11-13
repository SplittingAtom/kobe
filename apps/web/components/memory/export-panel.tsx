"use client";

import { SEMANTIC_MEMORY_SCOPE_LABELS } from "@kobe/protocol";
import { useMemo, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import { createTransferApi, exportFileName } from "../../lib/memory/transfer-api";
import { ErrorNotice } from "../admin/error-notice";
import { Button, Card, Checkbox, Notice } from "../ui/console";

const TYPES = { json: "application/json", csv: "text/csv" } as const;

/** Hands the browser the downloaded file. */
function saveFile(bytes: Uint8Array, name: string, type: string): void {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Export for curators (KOBE-385, SM21): one scope as JSON (a Kobe export, which imports again as
 * it was) or CSV. Every export is recorded in the audit log.
 */
export function ExportPanel({
  teamId,
  scope,
}: {
  readonly teamId: string | undefined;
  readonly scope: "team" | "site";
}) {
  const api = useMemo(() => createTransferApi(teamId), [teamId]);
  const [inactive, setInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const label = SEMANTIC_MEMORY_SCOPE_LABELS[scope];

  const run = async (format: "json" | "csv") => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await api.exportScope(scope, format, inactive);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    const day = new Date().toISOString().slice(0, 10);
    saveFile(res.data, exportFileName(scope, format, day), TYPES[format]);
    setNotice(`Exported ${label} as ${format.toUpperCase()}.`);
  };

  return (
    <Card title={`Export ${label}`} level={2}>
      <p className="m-0 mb-3 text-sm text-console-muted">
        Statements, kinds, tags and pins; never who wrote them or the conversations they came from.
        Each export is recorded in the audit log.
      </p>
      <Checkbox
        label="Include archived and superseded memories"
        checked={inactive}
        onChange={(e) => setInactive(e.target.checked)}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void run("json")}>
          Export JSON
        </Button>
        <Button disabled={busy} onClick={() => void run("csv")}>
          Export CSV
        </Button>
      </div>
      {error && <ErrorNotice error={error} />}
      <div role="status">
        {notice && (
          <Notice tone="success">
            <p>{notice}</p>
          </Notice>
        )}
      </div>
    </Card>
  );
}
