"use client";

/**
 * The artifact panel (KOBE-130, D-6/D-7 of docs/ledger/KOBE-55.md), assistant-ui's with-artifacts
 * pattern: a side panel next to the thread, opened from the run notice, the tool card or the
 * thread's artifact list. The panel is a labelled region, closable with Escape. What it shows comes
 * from `/v1/artifacts` (team in `X-Kobe-Team`); HTML and SVG are shown in a sandboxed frame loaded
 * from the server's frame route (`artifact-views.tsx`).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { artifactContentUrl, type ArtifactDetailView } from "../../lib/chat/artifacts";
import type { ApiError } from "../../lib/api/client";
import { cn } from "../../lib/utils";
import { ErrorNotice } from "../admin/error-notice";
import { IconAction } from "../shell/icon-action";
import { ArtifactBody } from "./artifact-views";
import { useChatSession, useKobeExtras } from "./kobe-runtime";

interface OpenRequest {
  readonly id: string;
  /** A specific version; absent = the latest, following updates. */
  readonly version: number | undefined;
  /** Distinguishes two requests for the same artifact, so a click resets the version. */
  readonly seq: number;
}

export interface ArtifactPanelApi {
  readonly openId: string | null;
  openArtifact(id: string, version?: number): void;
  close(): void;
}

const ArtifactPanelContext = createContext<ArtifactPanelApi | null>(null);

/** Null outside a provider (slots rendered on their own show no Open button). */
export function useArtifactPanel(): ArtifactPanelApi | null {
  return useContext(ArtifactPanelContext);
}

/**
 * `scope` identifies what is on screen (team and thread): when it changes the open artifact belongs
 * to something else, so the panel closes.
 */
export function ArtifactPanelProvider({
  scope,
  children,
}: {
  readonly scope: string;
  readonly children: ReactNode;
}) {
  const [request, setRequest] = useState<OpenRequest | null>(null);
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) {
    setSeenScope(scope);
    setRequest(null);
  }
  const opener = useRef<Element | null>(null);
  const seq = useRef(0);
  const openArtifact = useCallback((id: string, version?: number) => {
    opener.current = document.activeElement;
    seq.current += 1;
    setRequest({ id, version, seq: seq.current });
  }, []);
  const close = useCallback(() => {
    setRequest(null);
    const back = opener.current;
    opener.current = null;
    if (back instanceof HTMLElement) back.focus();
  }, []);
  const api = useMemo<ArtifactPanelApi>(
    () => ({ openId: request?.id ?? null, openArtifact, close }),
    [request?.id, openArtifact, close],
  );
  return (
    <ArtifactPanelContext.Provider value={api}>
      <ArtifactPanelRequest.Provider value={request}>{children}</ArtifactPanelRequest.Provider>
    </ArtifactPanelContext.Provider>
  );
}

const ArtifactPanelRequest = createContext<OpenRequest | null>(null);

/** Artifact events seen on the live run: a change means the list or the open artifact moved on. */
export function useArtifactEventCount(): number {
  const live = useKobeExtras()?.state.live;
  if (!live) return 0;
  const onTools = Object.values(live.tools).reduce((n, t) => n + t.artifacts.length, 0);
  const notices = live.notices.filter(
    (n) => n.type === "artifact.created" || n.type === "artifact.updated",
  ).length;
  return onTools + notices;
}

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
  const panel = useArtifactPanel();
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
        <IconAction command="artifact-close" onClick={() => panel?.close()} />
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

/** The panel region beside the thread; nothing while no artifact is open. */
export function ArtifactPanel({ className }: { readonly className?: string | undefined }) {
  const panel = useArtifactPanel();
  const request = useContext(ArtifactPanelRequest);
  const ref = useRef<HTMLElement>(null);
  const requestKey = request ? `${request.id}:${request.seq}` : null;
  useEffect(() => {
    if (requestKey !== null) ref.current?.focus();
  }, [requestKey]);
  if (!panel || !request) return null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.stopPropagation();
      panel.close();
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
      <PanelContent
        key={requestKey}
        id={request.id}
        {...(request.version === undefined ? {} : { initialVersion: request.version })}
      />
    </aside>
  );
}

/** Opens the panel: used by the run notice and the tool card. */
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
