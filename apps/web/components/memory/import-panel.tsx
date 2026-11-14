"use client";

import { SEMANTIC_MEMORY_SCOPE_LABELS } from "@kobe/protocol";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { ApiError } from "../../lib/api/client";
import {
  IMPORT_UI_MAX_ROWS,
  guessFormat,
  readImport,
  type ImportFile,
  type ImportFormat,
} from "../../lib/memory/import-file";
import { describeItemError } from "../../lib/memory/items-api";
import {
  ROW_CLASS_LABELS,
  createTransferApi,
  rowClass,
  type ImportPreview,
  type RowClass,
} from "../../lib/memory/transfer-api";
import { visible } from "../../lib/security/visible";
import { ErrorNotice } from "../admin/error-notice";
import {
  Badge,
  Button,
  Card,
  Field,
  Notice,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  type BadgeTone,
} from "../ui/console";
import { KIND_LABELS } from "./item-fields";

const FORMAT_LABELS: Readonly<Record<ImportFormat, string>> = {
  markdown: "Markdown bullets",
  csv: "CSV",
  json: "Kobe export (JSON)",
};

const TONE: Readonly<Record<RowClass, BadgeTone>> = {
  new: "done",
  "near-duplicate": "neutral",
  conflict: "attention",
  "policy-blocked": "failed",
  secret: "failed",
  "lint-flagged": "attention",
  unreadable: "failed",
};

const PREVIEW_HEADING = "import-preview";

type Previewed = { readonly file: ImportFile; readonly preview: ImportPreview };

/**
 * Import for curators (KOBE-385, SM21): paste or choose Markdown bullets (`- [kind] statement
 * #tag`), CSV (`statement,kind,tags,pinned`) or a Kobe export, at most 200 rows. **Preview**
 * classifies every row with the deterministic save checks (new, near-duplicate, conflicts with
 * Policy, blocked by Policy rules, secret, flagged by checks; no learning model, Q10) and stores
 * nothing; **Import** saves the clean (new) rows only, all or nothing. Rows left out can be added
 * one by one above, where Save anyway is offered.
 */
export function ImportPanel({
  teamId,
  scope,
  onImported,
}: {
  readonly teamId: string | undefined;
  readonly scope: "team" | "site";
  readonly onImported: () => void;
}) {
  const api = useMemo(() => createTransferApi(teamId), [teamId]);
  const [text, setText] = useState("");
  const [format, setFormat] = useState<ImportFormat>("markdown");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewed, setPreviewed] = useState<Previewed | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const label = SEMANTIC_MEMORY_SCOPE_LABELS[scope];

  const reset = () => {
    setPreviewed(null);
    setProblem(null);
    setError(null);
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText(content);
    setFormat(guessFormat(file.name, content));
    reset();
  };

  const preview = async () => {
    reset();
    setNotice(null);
    const read = readImport(format, text);
    if (!read.ok) return setProblem(read.message);
    setBusy(true);
    const res = await api.preview(scope, read.file);
    setBusy(false);
    if (!res.ok) return setError({ ...res.error, message: describeItemError(res.error) });
    setPreviewed({ file: read.file, preview: res.data });
  };

  // A new preview takes focus, so a screen reader hears it and the keyboard continues from there.
  useEffect(() => {
    if (previewed) heading.current?.focus();
  }, [previewed]);

  const clean = previewed?.preview.rows.filter((r) => rowClass(r) === "new") ?? [];

  const commit = async () => {
    if (!previewed || clean.length === 0) return;
    setBusy(true);
    const res = await api.commit(
      scope,
      previewed.file,
      clean.map((r) => r.index),
    );
    setBusy(false);
    if (!res.ok) return setError({ ...res.error, message: describeItemError(res.error) });
    setPreviewed(null);
    setText("");
    setNotice(
      res.data.created === 1 ? "Imported 1 memory." : `Imported ${res.data.created} memories.`,
    );
    onImported();
  };

  const counts = new Map<RowClass, number>();
  for (const r of previewed?.preview.rows ?? []) {
    const c = rowClass(r);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }

  return (
    <Card title={`Import into ${label}`} level={2}>
      <p className="m-0 mb-3 text-sm text-console-muted">
        One memory per line as <code>- [fact] statement #tag</code>, a CSV with the columns{" "}
        <code>statement,kind,tags,pinned</code> (tags separated by <code>;</code>), or a Kobe
        export. At most {IMPORT_UI_MAX_ROWS} rows. Preview checks every row; only new rows are
        imported.
      </p>
      <form
        aria-label={`Import into ${label}`}
        onSubmit={(e) => {
          e.preventDefault();
          void preview();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Format" className="w-fit">
            <Select
              value={format}
              onChange={(e) => {
                setFormat(e.target.value as ImportFormat);
                reset();
              }}
            >
              {(Object.keys(FORMAT_LABELS) as ImportFormat[]).map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="File" hint="Markdown, CSV or JSON. Or paste below.">
            <input
              type="file"
              accept=".md,.markdown,.txt,.csv,.json"
              onChange={(e) => void onFile(e)}
            />
          </Field>
        </div>
        <Field label="Memories to import" className="mt-3">
          <Textarea
            rows={6}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              reset();
            }}
            className="w-full font-mono"
          />
        </Field>
        {problem && (
          <p role="alert" className="m-0 mt-2 text-sm text-status-failed">
            {problem}
          </p>
        )}
        <div className="mt-3">
          <Button type="submit" disabled={busy}>
            Preview
          </Button>
        </div>
      </form>
      {error && <ErrorNotice error={error} />}
      <div role="status">
        {notice && (
          <Notice tone="success">
            <p>{notice}</p>
          </Notice>
        )}
      </div>
      {previewed && (
        <section aria-labelledby={PREVIEW_HEADING} className="mt-4">
          <h3
            id={PREVIEW_HEADING}
            ref={heading}
            tabIndex={-1}
            className="m-0 text-base font-semibold focus:outline-none"
          >
            Preview: {previewed.preview.rows.length} rows, {clean.length} to import
          </h3>
          <ul aria-label="Rows by result" className="m-0 my-2 flex list-none flex-wrap gap-2 p-0">
            {[...counts].map(([c, n]) => (
              <li key={c}>
                <Badge tone={TONE[c]}>
                  {ROW_CLASS_LABELS[c]}: {n}
                </Badge>
              </li>
            ))}
          </ul>
          <Table caption="Import preview" hideCaption>
            <TableHead>
              <TableRow>
                <TableHeader numeric>Row</TableHeader>
                <TableHeader>Memory</TableHeader>
                <TableHeader>Kind</TableHeader>
                <TableHeader>Result</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {previewed.preview.rows.map((r) => {
                const c = rowClass(r);
                return (
                  <TableRow key={r.index}>
                    <TableCell numeric>{r.index + 1}</TableCell>
                    <TableCell className="[overflow-wrap:anywhere] whitespace-pre-wrap">
                      {visible(r.statement)}
                      {(r.tags.length > 0 || r.pinned || r.policy) && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {r.policy && <Badge tone="accent">Policy</Badge>}
                          {r.pinned && <Badge tone="accent">Pinned</Badge>}
                          {r.tags.map((t) => (
                            <Badge key={t}>{visible(t)}</Badge>
                          ))}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{r.kind ? KIND_LABELS[r.kind] : "—"}</TableCell>
                    <TableCell>
                      <Badge tone={TONE[c]}>{ROW_CLASS_LABELS[c]}</Badge>
                      {r.issues.length > 0 && (
                        <ul className="m-0 mt-1 ps-4 text-sm">
                          {r.issues.map((i, n) => (
                            <li key={`${i.code}-${n}`}>{i.message}</li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy || clean.length === 0}
              onClick={() => void commit()}
            >
              {clean.length === 1 ? "Import 1 new row" : `Import ${clean.length} new rows`}
            </Button>
            <Button disabled={busy} onClick={reset}>
              Cancel
            </Button>
          </div>
        </section>
      )}
    </Card>
  );
}
