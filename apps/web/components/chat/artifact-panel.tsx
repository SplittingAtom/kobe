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
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { artifactContentUrl, type ArtifactDetailView } from "../../lib/chat/artifacts";
import type { ApiError } from "../../lib/api/client";
import { artifactAsSheet } from "../../lib/shell/layout";
import { cn } from "../../lib/utils";
import { ErrorNotice } from "../admin/error-notice";
import { ArtifactResizeHandle } from "../shell/artifact-resize";
import { IconAction } from "../shell/icon-action";
import { useShellBand } from "../shell/shell-band";
import { useModalLayer } from "../shell/use-modal-layer";
import { ArtifactTabStrip, artifactTabId, artifactTabpanelId } from "./artifact-tab-strip";
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
  const events = useArtifactEventCount(id);
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

export const artifactTitleId = (id: string) => `kobe-artifact-title-${id}`;

/**
 * One tab's artifact. Every open tab stays mounted (hidden while inactive), so a tab keeps the
 * version the member chose and its loaded content; `initialVersion` applies when the tab opens.
 */
function PanelContent({
  id,
  initialVersion,
  onTitle,
}: {
  readonly id: string;
  readonly initialVersion: number | undefined;
  readonly onTitle: (id: string, title: string) => void;
}) {
  const session = useChatSession();
  const detail = useArtifactDetail(id);
  const [pinned, setPinned] = useState<number | null>(initialVersion ?? null);
  const artifact = detail.artifact;
  const title = artifact?.title;
  useEffect(() => {
    if (title !== undefined) onTitle(id, title);
  }, [id, title, onTitle]);
  const versions = artifact?.versions.map((v) => v.version) ?? [];
  const latest = artifact?.currentVersion ?? 1;
  const version = pinned !== null && versions.includes(pinned) ? pinned : latest;

  return (
    <>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 id={artifactTitleId(id)} className="min-w-0 flex-1 truncate text-sm font-medium">
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

/** Tab titles: the thread's list, else the run's announcement, else the loaded artifact. */
function useTabTitles(open: readonly string[]) {
  const panel = useArtifactPanel();
  const [loaded, setLoaded] = useState<Readonly<Record<string, string>>>({});
  const onTitle = useCallback(
    (id: string, title: string) =>
      setLoaded((prev) => (prev[id] === title ? prev : { ...prev, [id]: title })),
    [],
  );
  const listed = new Map(panel?.artifacts?.map((a) => [a.id, a.title]));
  const tabs = open.map((id, index) => ({
    id,
    title: listed.get(id) ?? panel?.createdTitles[id] ?? loaded[id] ?? `Artifact ${index + 1}`,
  }));
  return { tabs, onTitle };
}

/**
 * Under 820 px the column is a sheet (CE7, CE8, KOBE-201): over the conversation from 768 px, full
 * screen and modal below it. Back (or Escape) hides it and focus returns to what opened it.
 */
function useSheetLayer(ref: RefObject<HTMLElement | null>) {
  const panel = useArtifactPanel();
  const band = useShellBand();
  const sheet = artifactAsSheet(band);
  const hide = useCallback(() => panel?.hideSheet(), [panel]);
  useModalLayer(ref, panel?.sheetOpen === true, hide, {
    modal: band === "single",
    escape: false, // the panel's own Escape (below) goes back
  });
  return { sheet, modal: band === "single" };
}

/** The artifact column's content: tabs, the open artifacts and the resize handle. */
export function ArtifactPanel({ className }: { readonly className?: string | undefined }) {
  const panel = useArtifactPanel();
  const request = useContext(ArtifactPanelRequest);
  const ref = useRef<HTMLElement>(null);
  const requestKey = request ? `${request.id}:${request.seq}` : null;
  useEffect(() => {
    if (requestKey !== null) ref.current?.focus();
  }, [requestKey]);
  const { sheet, modal } = useSheetLayer(ref);
  const { tabs, onTitle } = useTabTitles(panel?.tabs.open ?? []);
  const active = panel?.openId ?? null;
  if (!panel || active === null) return null; // no tabs: no column (CE6)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.stopPropagation();
    if (sheet) {
      panel.hideSheet();
      return;
    }
    const last = panel.tabs.open.length === 1;
    panel.close();
    if (!last) ref.current?.focus();
  };
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      role={modal ? "dialog" : "region"}
      aria-modal={modal || undefined}
      aria-labelledby={artifactTitleId(active)}
      onKeyDown={onKeyDown}
      className={cn(
        "bg-background flex min-h-96 min-w-0 flex-col border-s outline-none",
        className,
      )}
    >
      <div className="flex shrink-0 items-center border-b">
        {sheet && <IconAction command="artifact-back" onClick={panel.hideSheet} />}
        <div className="min-w-0 flex-1">
          <ArtifactTabStrip
            tabs={tabs}
            active={active}
            onSelect={panel.activate}
            onClose={panel.closeTab}
          />
        </div>
      </div>
      {tabs.map(({ id }) => (
        <div
          key={id}
          role="tabpanel"
          id={artifactTabpanelId(id)}
          aria-labelledby={artifactTabId(id)}
          hidden={id !== active}
          className="min-h-0 flex-1 flex-col [&:not([hidden])]:flex"
        >
          <PanelContent
            id={id}
            initialVersion={request?.id === id ? request.version : undefined}
            onTitle={onTitle}
          />
        </div>
      ))}
      {!sheet && <ArtifactResizeHandle width={panel.width} onChange={panel.setWidth} />}
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
