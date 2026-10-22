/**
 * Test doubles for the notebook views (KOBE-465): a workspace that saves and reads one file, a
 * kernel API that records calls, and run event streams the test feeds.
 */
import { useState } from "react";
import { vi } from "vitest";
import type { KobeEvent, KobeEventPayload, KobeEventType, NotebookRunBody } from "@kobe/protocol";
import type { ApiResult } from "../../lib/api/client";
import type { EventSourceLike } from "../../lib/chat/stream";
import type { FilesApi } from "../../lib/files/api";
import { sha256Hex } from "../../lib/files/editor";
import { EditDraftStore, FileReviewStore } from "../../lib/files/editor-state";
import type { KernelStart, NotebookApi, NotebookRunStarted } from "../../lib/notebooks/api";
import { NotebookExecStore } from "../../lib/notebooks/executions";
import NotebookView from "./notebook-view";
import type { KernelWiring } from "./use-kernel";

export const TEAM = "00000000-0000-4000-8000-0000000000aa";
export const THREAD = "00000000-0000-4000-8000-0000000000bb";

const enc = (s: string) => new TextEncoder().encode(s);

export class StubSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.readyState = 2;
  }
  send(event: KobeEvent) {
    for (const l of this.listeners.get(event.type) ?? []) {
      l(new MessageEvent(event.type, { data: JSON.stringify(event) }));
    }
  }
}

let seq = 0;
export function ev<T extends KobeEventType>(
  runId: string,
  type: T,
  payload: KobeEventPayload<T>,
): KobeEvent {
  seq += 1;
  return { run_id: runId, seq, ts: "2026-10-21T10:00:00Z", type, payload } as KobeEvent;
}

/** One workspace file that saves at a version and reads back. */
export class Workspace {
  text: string;
  saves: { base: string; text: string }[] = [];
  constructor(
    readonly path: string,
    text: string,
  ) {
    this.text = text;
  }
  readonly api = {
    read: vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: { bytes: enc(this.text), truncated: false, size: null },
    })),
    save: vi.fn(async (_path: string, base: string, text: string) => {
      this.saves.push({ base, text });
      if (base !== (await sha256Hex(enc(this.text)))) {
        return {
          ok: false as const,
          error: { status: 409, code: "version_conflict", message: "changed" },
        };
      }
      this.text = text;
      return { ok: true as const, status: 200, data: { sha256: await sha256Hex(enc(text)) } };
    }),
  } as unknown as FilesApi;
}

export class Kernel {
  runs: NotebookRunBody[] = [];
  ops: string[] = [];
  next: ApiResult<NotebookRunStarted>[] = [];
  /** `start` answers in order (then idle); a pending promise holds one. */
  starts: (ApiResult<KernelStart> | Promise<ApiResult<KernelStart>>)[] = [];
  sources: StubSource[] = [];
  readonly store = new NotebookExecStore();
  readonly api: NotebookApi = {
    run: async (_thread, body) => {
      this.runs.push(body);
      const n = this.runs.length;
      return (
        this.next.shift() ?? {
          ok: true,
          status: 202,
          data: { runId: runId(n), execId: execId(n) },
        }
      );
    },
    start: async () => {
      this.ops.push("start");
      return this.starts.shift() ?? { ok: true, status: 200, data: { status: "idle" } };
    },
    kernel: async (_thread, op) => {
      this.ops.push(op);
      return {
        ok: true,
        status: 200,
        data: { status: op === "restart" ? "restarted" : "interrupted" },
      };
    },
  };
  wiring(threadId: string | null = THREAD, readOnly = false): KernelWiring {
    return {
      threadId,
      readOnly,
      api: this.api,
      runs: this.store,
      teamId: TEAM,
      eventSource: (url) => {
        const s = new StubSource(url);
        this.sources.push(s);
        return s;
      },
    };
  }
}

export const runId = (n: number) => `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`;
export const execId = (n: number) => `00000000-0000-4000-9000-${String(100 + n).padStart(12, "0")}`;

/** The notebook as the file tab shows it: `onSaved` shows the saved text without a read. */
export function Harness({
  workspace,
  kernel,
  sha,
  drafts = new EditDraftStore(),
  reviews = new FileReviewStore(),
  onReload = () => {},
}: {
  readonly workspace: Workspace;
  readonly kernel: KernelWiring | undefined;
  readonly sha: string;
  readonly drafts?: EditDraftStore;
  readonly reviews?: FileReviewStore;
  readonly onReload?: () => void;
}) {
  const [file, setFile] = useState({ text: workspace.text, sha });
  return (
    <NotebookView
      path={workspace.path}
      text={file.text}
      sha256={file.sha}
      truncated={false}
      files={workspace.api}
      drafts={drafts}
      reviews={reviews}
      kernel={kernel}
      onSaved={(text, sha256) => setFile({ text, sha: sha256 })}
      onReload={onReload}
    />
  );
}

export function notebookJson(cells: readonly Record<string, unknown>[], minor = 5): string {
  return `${JSON.stringify({ nbformat: 4, nbformat_minor: minor, metadata: {}, cells }, null, 1)}\n`;
}
