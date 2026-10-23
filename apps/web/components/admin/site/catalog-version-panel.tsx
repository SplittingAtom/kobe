"use client";

import { lazy, Suspense, useState } from "react";
import {
  getCatalogVersion,
  getCatalogVersionFile,
  type CatalogVersionView,
  type RawVersionFile,
} from "../../../lib/admin/api/site/catalog-edit";
import type { EditorLanguage } from "../../../lib/files/editor";
import type { ScanPreview } from "../../../lib/skills/drafts-api";
import { Markdown } from "../../chat/markdown";
import { Findings } from "../../skills/feedback";
import { Button, Notice, Section } from "../../ui/console";
import { ErrorNotice } from "../error-notice";
import { ResourceView } from "../parts";
import { useResource } from "../use-resource";

/** CodeMirror loads on demand (as the file editor's Raw view), read-only here. */
const CodeEditor = lazy(() => import("../../files/code-editor"));

const LANGUAGES: Readonly<Record<string, EditorLanguage>> = {
  md: "markdown",
  json: "json",
  csv: "csv",
  tsv: "tsv",
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
};

/** The language mode of a package path, by its extension; null is plain text. */
export function languageOf(path: string): EditorLanguage | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext ? (LANGUAGES[ext] ?? null) : null;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

function Pre({ label, value }: { readonly label: string; readonly value: unknown }) {
  return (
    <pre
      aria-label={label}
      className="m-0 max-h-80 overflow-auto rounded border border-console-border bg-console-panel p-2 font-mono text-xs whitespace-pre-wrap"
    >
      {json(value)}
    </pre>
  );
}

/** The stored scan as the scan preview's findings list shows it. */
function scanOf(scan: Readonly<Record<string, unknown>>): ScanPreview | null {
  const verdict = scan.verdict;
  if (verdict !== "pass" && verdict !== "caution" && verdict !== "block") return null;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    rev: 0,
    verdict,
    findings: list(scan.findings) as ScanPreview["findings"],
    scripts: list(scan.scripts) as string[],
    skipped: list(scan.skipped) as string[],
  };
}

function FileView({
  skillId,
  versionId,
  path,
}: {
  readonly skillId: string;
  readonly versionId: string;
  readonly path: string;
}) {
  const { state } = useResource(() => getCatalogVersionFile(skillId, versionId, path));
  const [raw, setRaw] = useState(false);
  return (
    <ResourceView state={state} label={path}>
      {(file: RawVersionFile) => {
        const markdown = path === "SKILL.md" && file.encoding === "text";
        return (
          <div className="grid gap-2">
            <p className="m-0 text-sm text-console-muted">
              {file.size.toLocaleString()} bytes, SHA-256 <code>{file.sha256}</code>
              {file.encoding === "hex" ? " (binary: a hex dump)" : ""}
              {file.truncated ? " (only the beginning is shown)" : ""}
            </p>
            {markdown && (
              <div>
                <Button size="sm" onClick={() => setRaw((r) => !r)}>
                  {raw ? "Rendered" : "Raw"}
                  <span className="sr-only"> view of {path}</span>
                </Button>
              </div>
            )}
            {markdown && !raw ? (
              <div className="rounded border border-console-border p-3">
                <Markdown text={file.text} />
              </div>
            ) : (
              <div className="h-[28rem] overflow-hidden rounded border border-console-border">
                <Suspense fallback={<p role="status">Loading the viewer…</p>}>
                  <CodeEditor
                    value={file.text}
                    language={file.encoding === "text" ? languageOf(path) : null}
                    label={`Contents of ${path} (read-only)`}
                    readOnly
                  />
                </Suspense>
              </div>
            )}
          </div>
        );
      }}
    </ResourceView>
  );
}

function VersionDetail({
  skillId,
  view,
}: {
  readonly skillId: string;
  readonly view: CatalogVersionView;
}) {
  const [path, setPath] = useState<string>("SKILL.md");
  const scan = scanOf(view.scan);
  return (
    <div className="grid gap-4">
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt>Runtime hash</dt>
        <dd className="m-0 break-all font-mono">{view.hashes.runtime}</dd>
        <dt>Package hash</dt>
        <dd className="m-0 break-all font-mono">{view.hashes.package}</dd>
      </dl>
      <div className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label={`Files of ${view.version.semver}`}>
          <ul className="m-0 list-none p-0">
            {view.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  aria-current={f.path === path ? "true" : undefined}
                  className="w-full truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-console-panel aria-[current=true]:bg-console-panel aria-[current=true]:font-semibold"
                  onClick={() => setPath(f.path)}
                >
                  {f.path}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0">
          {view.files.some((f) => f.path === path) ? (
            <FileView key={path} skillId={skillId} versionId={view.version.id} path={path} />
          ) : (
            <p>Pick a file.</p>
          )}
        </div>
      </div>
      <Section title="Frontmatter" level={3}>
        {view.frontmatter ? (
          <Pre label="SKILL.md frontmatter" value={view.frontmatter} />
        ) : (
          <Notice tone="warn">{view.frontmatterProblem}</Notice>
        )}
      </Section>
      <Section title="Scan" level={3}>
        {scan ? <Findings scan={scan} /> : <p>No scan recorded.</p>}
      </Section>
      <Section title="Provenance" level={3}>
        <Pre label="provenance.json, as recorded" value={view.provenance} />
      </Section>
      <Section title="Manifest" level={3}>
        <Pre label="kobe.skill.yaml" value={view.manifest} />
      </Section>
    </div>
  );
}

/** One version of a catalog skill: files (read-only), frontmatter, scan, provenance, hashes. */
export function CatalogVersionPanel({
  skillId,
  versionId,
}: {
  readonly skillId: string;
  readonly versionId: string;
}) {
  const { state } = useResource(() => getCatalogVersion(skillId, versionId));
  if (state.status === "error") return <ErrorNotice error={state.error} />;
  return (
    <ResourceView state={state} label="the version">
      {(view) => <VersionDetail skillId={skillId} view={view} />}
    </ResourceView>
  );
}
