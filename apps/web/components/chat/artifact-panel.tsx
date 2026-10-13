"use client";

/**
 * The artifact column (KOBE-130, D-6/D-7 of docs/ledger/KOBE-55.md; tabs KOBE-200, CE6),
 * assistant-ui's with-artifacts pattern: a tab per artifact opened in the thread, opened from the
 * run notice, the tool card or the thread's artifact list, or by the agent creating one. The
 * column is a labelled region; Escape closes the active tab, and with no tabs it is gone. It is
 * view-only (member editing is a later spec). What it shows comes from `/v1/artifacts` (team in
 * `X-Kobe-Team`); HTML and SVG are shown in a sandboxed frame loaded from the server's frame route
 * (`artifact-views.tsx`). State: `artifact-state.tsx`.
 */
import { useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { artifactContentUrl, type ArtifactDetailView } from "../../lib/chat/artifacts";
import type { ApiError } from "../../lib/api/client";
import { cn } from "../../lib/utils";
import { ErrorNotice } from "../admin/error-notice";
import { ArtifactResizeHandle } from "../shell/artifact-resize";
import { IconAction } from "../shell/icon-action";
import { ARTIFACT_TABPANEL_ID, ArtifactTabStrip, artifactTabId } from "./artifact-tab-strip";
import { ArtifactPanelRequest, useArtifactEventCount, useArtifactPanel } from "./artifact-state";
import { ArtifactBody } from "./artifact-views";
import { useChatSession } from "./kobe-runtime";

interface Detail {
  readonly artifact: ArtifactDetailView | null;
  /** The last load failed: fatal without an artifact, a small notice with one. */
  readonly error: ApiError | null;
}

function useArtifactDetail(id: string): Detail {
  const session = useChatSession();
  const events = useArtifactEventCount();
  const [state, setState] = useState<Detail>({ artifact: null, error: null });
  useEffect(() => {
    let current = true;
    void session.api.getArtifact(id).then((res) => {
      if (!current) return;
      // A failed refresh keeps the last good artifact on screen.
      setState((prev) =>
        res.ok
          ? { artifact: res.data, error: null }
          : { artifact: prev.artifact, error: res.error },
      );
    });
    return () => {
      current = false;
    };
  }, [session, id, events]);
  return state;
}

function VersionNav({
  versions,
  current,
  onChange,
}: {
  readonly versions: readonly number[];
  readonly current: number;
  readonly onChange: (version: number) => void;
}) {
  const index = versions.indexOf(current);
  const prev = versions[index - 1];
  const next = versions[index + 1];
  return (
    <div role="group" aria-label="Versions" className="flex items-center gap-1 text-xs">
      <IconAction
        command="artifact-previous"
        disabled={prev === undefined}
        onClick={() => prev !== undefined && onChange(prev)}
      />
      <span aria-live="polite">{`Version ${current} of ${versions.at(-1) ?? current}`}</span>
      <IconAction
        command="artifact-next"
        disabled={next === undefined}
        onClick={() => next !== undefined && onChange(next)}
      />
    </div>
  );
}

function PanelContent({
  id,
  initialVersion,
}: {
  readonly id: string;
  readonly initialVersion?: number;
}) {
  const session = useChatSession();
  const detail = useArtifactDetail(id);
  const [pinned, setPinned] = useState<number | null>(initialVersion ?? null);
  const artifact = detail.artifact;
  const versions = artifact?.versions.map((v) => v.version) ?? [];
  const latest = artifact?.currentVersion ?? 1;
  const version = pinned !== null && versions.includes(pinned) ? pinned : latest;

  return (
    <>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 id="kobe-artifact-title" className="min-w-0 flex-1 truncate text-sm font-medium">
          {artifact?.title ?? "Artifact"}
        </h2>
        {artifact && (
          <>
            <VersionNav
              versions={versions}
              current={version}
              onChange={(v) => setPinned(v === latest ? null : v)}
            />
            <IconAction
              command="artifact-download"
              href={artifactContentUrl(artifact.id, version, session.teamId)}
              download
              label={`Download version ${version}`}
            />
          </>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!artifact && !detail.error && <p role="status">Loading the artifact…</p>}
        {detail.error && !artifact && <ErrorNotice error={detail.error} />}
        {detail.error && artifact && (
          <p role="alert" className="text-destructive mb-2 text-xs">
            Could not refresh this artifact; showing the last version loaded.
          </p>
        )}
        {artifact && (
          <ArtifactBody key={`${artifact.id}:${version}`} artifact={artifact} version={version} />
        )}
      </div>
    </>
  );
}

/** The artifact column's content: tabs, the active artifact and the resize handle. */
export function ArtifactPanel({ className }: { readonly className?: string | undefined }) {
  const panel = useArtifactPanel();
  const request = useContext(ArtifactPanelRequest);
  const ref = useRef<HTMLElement>(null);
  const requestKey = request ? `${request.id}:${request.seq}` : null;
  useEffect(() => {
    if (requestKey !== null) ref.current?.focus();
  }, [requestKey]);
  const active = panel?.openId ?? null;
  if (!panel || active === null) return null; // no tabs: no column (CE6)
  const titles = new Map(panel.artifacts?.map((a) => [a.id, a.title]));
  const tabs = panel.tabs.open.map((id) => ({ id, title: titles.get(id) ?? "Artifact" }));
  const pinned = request?.id === active ? request : null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.stopPropagation();
      const last = panel.tabs.open.length === 1;
      panel.close();
      if (!last) ref.current?.focus();
    }
  };
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-labelledby="kobe-artifact-title"
      onKeyDown={onKeyDown}
      className={cn(
        "bg-background flex min-h-96 min-w-0 flex-col border-s outline-none",
        className,
      )}
    >
      <ArtifactTabStrip
        tabs={tabs}
        active={active}
        onSelect={panel.activate}
        onClose={panel.closeTab}
      />
      <div
        role="tabpanel"
        id={ARTIFACT_TABPANEL_ID}
        aria-labelledby={artifactTabId(active)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <PanelContent
          key={pinned ? `${active}:${pinned.seq}` : active}
          id={active}
          {...(pinned?.version === undefined ? {} : { initialVersion: pinned.version })}
        />
      </div>
      <ArtifactResizeHandle width={panel.width} onChange={panel.setWidth} />
    </aside>
  );
}

/** Opens an artifact's tab: used by the run notice and the tool card. */
export function OpenArtifactButton({
  id,
  version,
  title,
}: {
  readonly id: string;
  readonly version?: number | undefined;
  readonly title: string;
}) {
  const panel = useArtifactPanel();
  if (!panel) return null;
  return (
    <IconAction
      command="open-artifact"
      label={`Open artifact: ${title}`}
      size="sm"
      className="ms-2"
      aria-expanded={panel.openId === id}
      onClick={() => panel.openArtifact(id, version)}
    />
  );
}
