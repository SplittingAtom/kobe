"use client";

import type { ThreadContext } from "@kobe/protocol";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { formatTokens } from "../../lib/admin/usage-format";
import {
  WAKE_GIVE_UP_MS,
  approximateNotice,
  formatShare,
  gaugeModel,
  nextWakeDelay,
  type ContextRead,
  type GaugeModel,
} from "../../lib/chat/context-viewer";
import type { Panel } from "../../lib/shell/panels";
import { useKobeExtras } from "../chat/kobe-runtime";
import { ContextStack } from "./context-stack";
import { ContextText, type ContextTextHandle } from "./context-text";
import { IconAction } from "./icon-action";
import { WorkspacePanel } from "./workspace-panel";
import styles from "./context-viewer.module.css";

const PANEL: Panel = { id: "context-viewer", title: "Context", embedded: true };

const TOO_LONG = "Your workspace is taking too long to wake. Try again in a moment.";

type Phase =
  | { readonly status: "loading" }
  | { readonly status: "waking"; readonly since: number }
  | { readonly status: "ready" }
  | { readonly status: "error"; readonly message: string; readonly terminal: boolean };

/**
 * Reads the context on open and on each `again()`: while the workspace wakes (202) it asks again
 * after the server's hint, backed off and capped, well under the route's 30 reads a minute, and
 * gives up after a few minutes. A terminal error stops it.
 */
function useContextRead(read: () => Promise<ContextRead> | null) {
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [context, setContext] = useState<ThreadContext | null>(null);
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const ask = (n: number) => {
      const pending = readRef.current();
      if (pending === null) return;
      void pending.then((r) => {
        if (!current) return;
        if (r.kind === "ready") {
          setContext(r.context);
          setPhase({ status: "ready" });
        } else if (r.kind === "error") {
          setPhase({ status: "error", message: r.message, terminal: r.terminal });
        } else if (Date.now() - started > WAKE_GIVE_UP_MS) {
          setPhase({ status: "error", message: TOO_LONG, terminal: false });
        } else {
          setPhase({ status: "waking", since: started });
          timer = setTimeout(() => ask(n + 1), nextWakeDelay(n, r.retryAfterMs));
        }
      });
    };
    setPhase({ status: "loading" });
    ask(0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [attempt]);
  return { phase, context, again: () => setAttempt((n) => n + 1) };
}

/** "Waking your workspace… 6 s", counting while it wakes. */
function WakeProgress({ since }: { readonly since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1_000));
  return (
    <p className={styles.status} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      Waking your workspace… {seconds} s
    </p>
  );
}

function summaryOf(context: ThreadContext, model: GaugeModel): string {
  const { total, window } = model;
  const used =
    window === null
      ? `${formatTokens(total)} tokens`
      : `${formatTokens(total)} of ${formatTokens(window)} tokens (${formatShare(total / window)})`;
  const parts = [used];
  if (context.model !== null) parts.push(context.model);
  if (context.captured_at !== null) {
    parts.push(`as of ${new Date(context.captured_at).toLocaleTimeString()}`);
  }
  return parts.join(" · ");
}

function Notices({ context }: { readonly context: ThreadContext }) {
  const approximate = approximateNotice(context);
  return (
    <>
      {approximate !== null && (
        <p className={styles.notice} role="note" data-context-approximate>
          {approximate}
        </p>
      )}
      {context.source === "none" && (
        <p className={styles.notice} role="note">
          No model call yet in this conversation.
        </p>
      )}
      {context.truncated && (
        <p className={styles.notice} role="note">
          {context.omitted_sections > 0
            ? `Some sections were shortened, and ${context.omitted_sections} left out of the middle, to fit.`
            : "Some sections were shortened to fit."}
        </p>
      )}
      {context.tokens_basis === "estimate" && (
        <p className={styles.notice} role="note">
          The model reported no usage for this call: the token counts are estimates.
        </p>
      )}
    </>
  );
}

function PhaseLine({ phase, onRetry }: { readonly phase: Phase; readonly onRetry: () => void }) {
  if (phase.status === "loading") {
    return (
      <p className={styles.status} role="status">
        <span className={styles.spinner} aria-hidden="true" />
        Reading the context…
      </p>
    );
  }
  if (phase.status === "waking") return <WakeProgress since={phase.since} />;
  if (phase.status === "error") {
    return (
      <div className={styles.error} role="alert">
        <span>{phase.message}</span>
        {!phase.terminal && (
          <button type="button" className={styles.smallButton} onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  }
  return null;
}

/**
 * The context viewer (KOBE-471, docs/specs/context-viewer.md): what the thread's latest model call
 * sent the model, read live from the owner's sandbox. A panel over the workspace like the
 * consoles (`WorkspacePanel`: modal, Escape and Close return focus to the gauge), rendered by
 * `ContextViewerHost` beside the workspace grid as the Threads panel is, so it covers the window. The raw text takes two thirds of the width; the stacked gauge
 * and its legend the rest (stacked above the text at phone width). Owner only: the gauge offers it
 * only on the member's own thread (the route answers 403 to anyone else).
 */
export function ContextViewer({
  read,
  fallbackWindow,
  onClose,
}: {
  readonly read: () => Promise<ContextRead> | null;
  /** The gauge's window (the thread's next model), used when the answer has none. */
  readonly fallbackWindow: number | null;
  readonly onClose: () => void;
}) {
  const { phase, context, again } = useContextRead(read);
  const text = useRef<ContextTextHandle>(null);
  const model = useMemo(
    () => (context === null ? null : gaugeModel(context, fallbackWindow)),
    [context, fallbackWindow],
  );
  const busy = phase.status === "loading" || phase.status === "waking";
  return (
    <WorkspacePanel panel={PANEL} path="context-viewer" onClose={onClose}>
      <div className={styles.viewer} data-context-viewer>
        <div className={styles.toolbar}>
          <p className={styles.summary}>
            {context !== null && model !== null ? summaryOf(context, model) : ""}
          </p>
          <IconAction
            command="refresh-files"
            label="Refresh the context"
            aria-disabled={busy}
            onClick={busy ? undefined : again}
          />
        </div>
        <PhaseLine phase={phase} onRetry={again} />
        {context !== null && <Notices context={context} />}
        {context !== null && model !== null && (
          <div className={styles.columns}>
            <ContextText sections={context.sections} handle={text} />
            <ContextStack model={model} onPick={(section) => text.current?.show(section)} />
          </div>
        )}
      </div>
    </WorkspacePanel>
  );
}

/** Opens the viewer on the thread on screen, with the gauge's window; null: not offered here. */
type OpenViewer = (fallbackWindow: number | null) => void;

const OpenViewerContext = createContext<OpenViewer | null>(null);

/** The context gauge's way to open the viewer (KOBE-471); null outside the workspace. */
export function useOpenContextViewer(): OpenViewer | null {
  return useContext(OpenViewerContext);
}

/**
 * Holds the context viewer of the workspace (KOBE-471): the gauge under the composer opens it,
 * and it renders after `children` (the workspace grid), outside the composer, so the panel is
 * not inside the conversation's layout. It closes when another thread comes on screen.
 */
export function ContextViewerHost({ children }: { readonly children: ReactNode }) {
  const extras = useKobeExtras();
  const threadId = extras?.state.threadId ?? null;
  const controller = extras?.controller ?? null;
  const [open, setOpen] = useState<{ threadId: string; window: number | null } | null>(null);
  const show = useCallback<OpenViewer>(
    (window) => {
      if (threadId !== null) setOpen({ threadId, window });
    },
    [threadId],
  );
  const close = useCallback(() => setOpen(null), []);
  return (
    <OpenViewerContext.Provider value={threadId === null ? null : show}>
      {children}
      {open !== null && open.threadId === threadId && controller !== null && (
        <ContextViewer
          read={controller.threadContext}
          fallbackWindow={open.window}
          onClose={close}
        />
      )}
    </OpenViewerContext.Provider>
  );
}
