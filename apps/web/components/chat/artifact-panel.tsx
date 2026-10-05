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
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, XIcon } from "lucide-react";
import { artifactContentUrl, type ArtifactDetailView } from "../../lib/chat/artifacts";
import type { ApiError } from "../../lib/api/client";
import { cn } from "../../lib/utils";
import { ErrorNotice } from "../admin/error-notice";
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

export function ArtifactPanelProvider({ children }: { readonly children: ReactNode }) {
  const [request, setRequest] = useState<OpenRequest | null>(null);
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

type Detail =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "ready"; readonly artifact: ArtifactDetailView };

function useArtifactDetail(id: string): Detail {
  const session = useChatSession();
  const events = useArtifactEventCount();
  const [state, setState] = useState<Detail>({ status: "loading" });
  useEffect(() => {
    let current = true;
    void session.api.getArtifact(id).then((res) => {
      if (!current) return;
      setState(
        res.ok ? { status: "ready", artifact: res.data } : { status: "error", error: res.error },
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
  const button =
    "hover:bg-muted focus-visible:ring-ring/50 inline-flex size-7 items-center justify-center rounded-md border disabled:opacity-40";
  return (
    <div role="group" aria-label="Versions" className="flex items-center gap-1 text-xs">
      <button
        type="button"
        className={button}
        aria-label="Previous version"
        disabled={prev === undefined}
        onClick={() => prev !== undefined && onChange(prev)}
      >
        <ChevronLeftIcon aria-hidden className="size-4" />
      </button>
      <span aria-live="polite">{`Version ${current} of ${versions.at(-1) ?? current}`}</span>
      <button
        type="button"
        className={button}
        aria-label="Next version"
        disabled={next === undefined}
        onClick={() => next !== undefined && onChange(next)}
      >
        <ChevronRightIcon aria-hidden className="size-4" />
      </button>
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
  const artifact = detail.status === "ready" ? detail.artifact : null;
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
            <a
              className="hover:bg-muted inline-flex size-7 items-center justify-center rounded-md border"
              href={artifactContentUrl(artifact.id, version, session.teamId)}
              download
              aria-label={`Download version ${version}`}
              title="Download"
            >
              <DownloadIcon aria-hidden className="size-4" />
            </a>
          </>
        )}
        <button
          type="button"
          className="hover:bg-muted inline-flex size-7 items-center justify-center rounded-md border"
          aria-label="Close artifact"
          onClick={() => panel?.close()}
        >
          <XIcon aria-hidden className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {detail.status === "loading" && <p role="status">Loading the artifact…</p>}
        {detail.status === "error" && <ErrorNotice error={detail.error} />}
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
    <button
      type="button"
      className="hover:bg-muted ms-2 rounded-md border px-2 py-0.5 text-xs"
      aria-label={`Open artifact: ${title}`}
      aria-expanded={panel.openId === id}
      onClick={() => panel.openArtifact(id, version)}
    >
      Open
    </button>
  );
}
