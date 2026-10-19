"use client";

import { useEffect, useRef, useState } from "react";
import {
  approveConnectorTemplates,
  getTemplateSource,
  listConnectorTemplates,
  type Connector,
  type TemplateReview,
  templateFrameUrl,
  type TemplateSource,
  type TemplateVersion,
} from "../../../lib/admin/api/site/connectors";
import { APP_FRAME_SANDBOX } from "../../../lib/apps/app-frame";
import { lineDiff } from "../../../lib/apps/line-diff";
import { attachStubBridge } from "../../../lib/apps/preview-bridge";
import { Badge, Button, Card } from "../../ui/console";
import { ResourceView } from "../parts";
import { useResource, type Mutation } from "../use-resource";

/**
 * Review of a connector's MCP Apps templates (KOBE-434, spec §5). Changed and new templates are
 * not shown to anyone until a site admin approves them here by the hash they reviewed. The source
 * is shown as escaped text (a line diff), never rendered; the optional preview runs the template
 * in the app sandbox with a stubbed bridge, so its calls fail and nothing reaches the server.
 */
const INVALID_TEXT: Readonly<Record<string, string>> = {
  ui_resource_invalid:
    "The server's version is not one UTF-8 HTML document of type text/html;profile=mcp-app up to 512 KiB.",
  ui_resource_hash_mismatch: "The server's version does not match its declared contentHash.",
};

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

function Version({ label, v }: { readonly label: string; readonly v: TemplateVersion }) {
  return (
    <section aria-label={label} className="min-w-0 text-sm">
      <h4 className="m-0 font-semibold">{label}</h4>
      <p className="my-1 break-all">
        SHA-256 <code>{v.sha256}</code> · {kib(v.bytes)}
      </p>
      <p className="my-1">Declared _meta.ui (ignored: apps get no network):</p>
      <pre className="m-0 max-h-40 overflow-auto rounded-md border border-console-border bg-console-panel p-2 text-xs">
        {JSON.stringify(v.meta, null, 2)}
      </pre>
    </section>
  );
}

const DIFF_MARK = { same: " ", removed: "-", added: "+" } as const;
const MAX_DIFF_LINES = 4000;

function SourceDiff({ source }: { readonly source: TemplateSource }) {
  const lines = lineDiff(source.approved?.html ?? "", source.live?.html ?? "");
  const shown = lines.slice(0, MAX_DIFF_LINES);
  return (
    <pre
      aria-label={`Source changes of ${source.uri}`}
      className="m-0 mt-2 max-h-96 overflow-auto rounded-md border border-console-border bg-console-panel p-2 text-xs"
    >
      {shown.map((l, i) => (
        <span
          key={i}
          className={
            l.kind === "added"
              ? "block text-console-success"
              : l.kind === "removed"
                ? "block text-console-danger"
                : "block"
          }
        >
          {DIFF_MARK[l.kind]} {l.text}
        </span>
      ))}
      {lines.length > shown.length ? `… ${lines.length - shown.length} more lines` : null}
    </pre>
  );
}

/**
 * The live template in the app sandbox, served by Kobe's admin frame route with a header CSP
 * (`sandbox allow-scripts`, no network); its bridge is stubbed: every call fails.
 */
export function TemplatePreview({ src, uri }: { readonly src: string; readonly uri: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => attachStubBridge(window, () => frame.current?.contentWindow ?? null), []);
  return (
    <iframe
      ref={frame}
      title={`Preview of ${uri}`}
      sandbox={APP_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      src={src}
      className="mt-2 h-90 w-full rounded-md border border-console-border bg-white"
    />
  );
}

function TemplateCard({
  connectorId,
  t,
  busy,
  onApprove,
}: {
  readonly connectorId: string;
  readonly t: TemplateReview;
  readonly busy: boolean;
  readonly onApprove: (uri: string, pinnedHash: string) => void;
}) {
  const [source, setSource] = useState<TemplateSource | null>(null);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadSource() {
    const res = await getTemplateSource(connectorId, t.uri);
    if (res.ok) setSource(res.data);
    else setError(res.error.message);
  }

  return (
    <Card role="article" aria-label={t.uri}>
      <h3 className="m-0 mb-2 text-base font-semibold break-all">
        <code>{t.uri}</code>{" "}
        {t.change === "added"
          ? "(new)"
          : t.change === "invalid"
            ? "(cannot be pinned)"
            : "(changed)"}
      </h3>
      {t.invalid ? (
        <p className="m-0 mb-2 text-sm">
          <Badge tone="attention">Cannot be approved</Badge> {INVALID_TEXT[t.invalid] ?? t.invalid}
        </p>
      ) : null}
      {/* Once loaded, the source's own versions are shown: the bytes, hashes and meta of one
          read, and Approve sends that hash (review M1). Before that, Approve is off. */}
      <div className="grid gap-3 md:grid-cols-2">
        {(source?.approved ?? t.approved) ? (
          <Version label="Approved" v={source?.approved ?? (t.approved as TemplateVersion)} />
        ) : null}
        {(source?.live ?? t.live) ? (
          <Version label="Now" v={source?.live ?? (t.live as TemplateVersion)} />
        ) : null}
      </div>
      {t.live ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {source === null ? (
            <Button size="sm" onClick={() => void loadSource()}>
              Show source<span className="sr-only"> of {t.uri}</span>
            </Button>
          ) : (
            <Button size="sm" onClick={() => setPreview((p) => !p)}>
              {preview ? "Hide preview" : "Preview"}
              <span className="sr-only"> of {t.uri}</span>
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={busy || source?.live === undefined}
            title={source === null ? "Show the source first" : undefined}
            onClick={() => {
              if (source?.live) onApprove(t.uri, source.live.pinnedHash);
            }}
          >
            Approve<span className="sr-only"> {t.uri}</span>
          </Button>
        </div>
      ) : null}
      {error ? <p className="m-0 mt-2 text-sm text-console-danger">{error}</p> : null}
      {source ? <SourceDiff source={source} /> : null}
      {source?.live !== undefined && preview ? (
        <>
          <p className="m-0 mt-2 text-sm text-console-muted">
            Preview: the app cannot call any tool here and reaches no server.
          </p>
          <TemplatePreview
            uri={t.uri}
            src={templateFrameUrl(connectorId, t.uri, "live", source.live.sha256)}
          />
        </>
      ) : null}
    </Card>
  );
}

export function TemplateReviewSection({
  connector,
  mutation,
  onChanged,
}: {
  readonly connector: Connector;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const { state, reload } = useResource(() => listConnectorTemplates(connector.id));

  async function approve(uri: string, pinnedHash: string) {
    const reviewed = [{ uri, pinnedHash }];
    const done = await mutation.run(
      () => approveConnectorTemplates(connector.id, reviewed),
      (r) => `Approved ${r.approved.length} app template${r.approved.length === 1 ? "" : "s"}.`,
    );
    reload();
    if (done) onChanged();
  }

  return (
    <section aria-label="App templates" className="mt-6">
      <h3 className="m-0 mb-2 text-base font-semibold">App templates</h3>
      <ResourceView state={state} label="app templates">
        {(templates) => {
          const pending = templates.filter((t) => t.status === "drifted");
          return (
            <>
              <p className="m-0 mb-3 text-sm text-console-muted">
                Changed and new app templates are not shown to anyone until you approve them; their
                tools' results show as text meanwhile.
              </p>
              {pending.length === 0 ? <p>No app templates are waiting for approval.</p> : null}
              <div className="flex flex-col gap-3">
                {pending.map((t) => (
                  <TemplateCard
                    key={t.uri}
                    connectorId={connector.id}
                    t={t}
                    busy={mutation.pending}
                    onApprove={(uri, hash) => void approve(uri, hash)}
                  />
                ))}
              </div>
            </>
          );
        }}
      </ResourceView>
    </section>
  );
}
