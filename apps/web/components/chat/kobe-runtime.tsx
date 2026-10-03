"use client";

/**
 * The assistant-ui runtime for Kobe (D16): `useRemoteThreadListRuntime` over the Thread API, and
 * per thread an `ExternalStoreRuntime` fed by the thread's controller, its entry tree projected to
 * a branchable message repository (`parentId` + `headId`).
 */
import {
  fromThreadMessageLike,
  MessageNotSentError,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  useRemoteThreadListRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type ExportedMessageRepository,
  type RemoteThreadListAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ApiError } from "../../lib/api/client";
import type { ChatSession } from "../../lib/chat/session";
import type { ThreadController } from "../../lib/chat/thread-controller";
import {
  initialThreadState,
  isThreadRunning,
  liveOverlay,
  type ThreadState,
} from "../../lib/chat/thread-state";
import {
  messageMeta,
  projectThread,
  type Projection,
  type ProjectedItem,
} from "../../lib/chat/tree";

export const ChatSessionContext = createContext<ChatSession | null>(null);

export function useChatSession(): ChatSession {
  const session = useContext(ChatSessionContext);
  if (!session) throw new Error("useChatSession needs a ChatSessionContext provider");
  return session;
}

/** What the thread view reads beside the messages (`useAuiState((s) => s.thread.extras)`). */
export interface KobeThreadExtras {
  readonly controller: ThreadController | null;
  readonly state: ThreadState;
  readonly projection: Projection;
}

export function useKobeExtras(): KobeThreadExtras | undefined {
  return useAuiState((s) => s.thread.extras as KobeThreadExtras | undefined);
}

const DRAFT_STATE = initialThreadState(null);
const noopSubscribe = () => () => {};

/** The controller of the thread on screen (a draft for a new thread), held while mounted. */
function useThreadController(session: ChatSession, remoteId: string | undefined) {
  const [held, setHeld] = useState<{ id: string | null; controller: ThreadController } | null>(
    null,
  );
  useEffect(() => {
    const id = remoteId ?? null;
    const controller = session.acquire(id);
    setHeld({ id, controller });
    return () => session.release(id, controller);
  }, [session, remoteId]);
  const controller = held && held.id === (remoteId ?? null) ? held.controller : null;
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? (() => DRAFT_STATE),
    controller?.getState ?? (() => DRAFT_STATE),
  );
  return { controller, state };
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/** Converts projected items to `ThreadMessage`s, reusing a message whose inputs didn't change. */
function useMessageRepository(projection: Projection): ExportedMessageRepository {
  const cache = useRef(new Map<string, { deps: readonly unknown[]; message: ThreadMessage }>());
  return useMemo(() => {
    const next = new Map<string, { deps: readonly unknown[]; message: ThreadMessage }>();
    const messages = projection.items.map((item: ProjectedItem) => {
      const cached = cache.current.get(item.message.id);
      const message =
        cached && sameDeps(cached.deps, item.deps)
          ? cached.message
          : fromThreadMessageLike(item.message, item.message.id, {
              type: "complete",
              reason: "unknown",
            });
      next.set(item.message.id, { deps: item.deps, message });
      return { message, parentId: item.parentId };
    });
    cache.current = next;
    return { headId: projection.headId, messages };
  }, [projection]);
}

function textOf(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

/** Where an edit of the user message `id` branches from (its entry's parent), if anywhere. */
function branchPointOf(projection: Projection, id: string | null | undefined) {
  if (!id) return undefined;
  const item = projection.items.find((i) => i.message.id === id);
  const meta = item ? messageMeta(item.message) : undefined;
  return meta?.kind === "user" ? meta : undefined;
}

function apiErrorOf(err: unknown, fallback: string): ApiError {
  const apiError = (err as { apiError?: ApiError } | null)?.apiError;
  return apiError ?? { status: 0, code: "client_error", message: `${fallback} Try again.` };
}

const CANNOT_BRANCH = {
  status: 409,
  code: "cannot_branch",
  message: "This message starts the conversation, so it can't be edited or regenerated.",
} as const;

/**
 * The per-thread runtime, called by the remote thread list for the thread on screen. It gets the
 * session by closure, not React context: assistant-ui runs this hook in its own thread host, where
 * the app's context providers are not reliably above it (a remounted app saw the previous
 * session's value).
 */
export function useKobeThreadRuntime(session: ChatSession): AssistantRuntime {
  const aui = useAui();
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const { controller, state } = useThreadController(session, remoteId);

  const overlay = liveOverlay(state);
  const projection = useMemo(
    () => projectThread(state.entries, state.summary?.leafEntryId ?? null, overlay),
    // `overlay` is rebuilt from these on every render; depend on its sources.
    [
      state.entries,
      state.summary?.leafEntryId,
      state.live,
      state.livePrompt,
      state.sending,
      state.runs,
    ],
  );
  const repository = useMessageRepository(projection);
  const projectionRef = useRef(projection);
  projectionRef.current = projection;

  /** Sends on the thread on screen; a new thread is created first (title = the message). */
  const send = async (text: string, parentEntryId?: string): Promise<boolean> => {
    if (text === "") return false;
    let threadId = aui.threadListItem.getState().remoteId;
    const created = threadId === undefined;
    if (threadId === undefined) {
      try {
        threadId = (await aui.threadListItem.initialize()).remoteId;
      } catch (err) {
        controller?.reportError(apiErrorOf(err, "The conversation could not be created."), text);
        return false;
      }
    }
    const target = session.peek(threadId) ?? controller;
    const sent = (await target?.send(text, parentEntryId)) ?? false;
    if (created) session.threadCreated();
    return sent;
  };

  const branchAndSend = async (text: string, userMessageId: string | null | undefined) => {
    const point = branchPointOf(projectionRef.current, userMessageId);
    if (!point || point.parentEntryId === null) {
      controller?.reportError(CANNOT_BRANCH, text);
      return;
    }
    await controller?.send(text, point.parentEntryId);
  };

  const inTrash = state.summary?.deletedAt != null;
  const extras: KobeThreadExtras = useMemo(
    () => ({ controller, state, projection }),
    [controller, state, projection],
  );

  return useExternalStoreRuntime<ThreadMessage>({
    messageRepository: repository,
    isRunning: isThreadRunning(state) || (state.sending !== undefined && !state.sending.queues),
    isLoading: state.phase === "loading",
    isDisabled: inTrash || state.phase === "error",
    extras,
    onNew: async (message) => {
      // A message that never reached the server goes back into the composer.
      if (!(await send(textOf(message)))) throw new MessageNotSentError();
    },
    onEdit: async (message) => branchAndSend(textOf(message), message.sourceId),
    onReload: async (parentId) => {
      const point = branchPointOf(projectionRef.current, parentId);
      await branchAndSend(point?.text ?? "", parentId);
    },
    onCancel: async () => controller?.stop(),
    setMessages: () => {
      // Branch switches are applied by the runtime and reported through unstable_onBranchChange.
    },
    unstable_onBranchChange: ({ headId }) => {
      if (headId === null) return;
      const entryId = projectionRef.current.lastEntryOfNode.get(headId);
      if (entryId !== undefined) void controller?.switchLeaf(entryId);
    },
    unstable_capabilities: { copy: true },
  });
}

function threadRuntimeHookFor(session: ChatSession): () => AssistantRuntime {
  return function useSessionThreadRuntime() {
    return useKobeThreadRuntime(session);
  };
}

/** The app-level runtime: the thread list (controlled by `threadId`) and the thread on screen. */
export function useKobeRuntime(options: {
  readonly session: ChatSession;
  readonly adapter: RemoteThreadListAdapter;
  readonly threadId: string | undefined;
  readonly onThreadIdChange: (threadId: string | undefined) => void;
}): AssistantRuntime {
  const { session } = options;
  const runtimeHook = useMemo(() => threadRuntimeHookFor(session), [session]);
  return useRemoteThreadListRuntime({
    adapter: options.adapter,
    threadId: options.threadId,
    onThreadIdChange: options.onThreadIdChange,
    runtimeHook,
  });
}
