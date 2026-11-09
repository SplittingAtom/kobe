import type {
  KobeToolsRequest,
  KobeToolsResponse,
  ProjectCommitFrame,
  ProjectCommitResultFrame,
} from "@kobe/protocol";
import { PushPathError } from "../workspace/sync.js";
import { toolsError } from "./channel.js";

/**
 * The agent side of `commit_project` (KOBE-580, spec CM6; contract: packages/protocol
 * `project-commits.ts` and `sandbox-wire/project-frames.ts`). kobe-policy has already let the
 * call through (a project write: a policy rule or a signed approval). One `project.commit`
 * kobe-tools request becomes, in this order and only if each step succeeds: push the whole
 * working copy through workspace sync (the server diffs the manifest, so it must hold every
 * edit), send the `project.commit` frame, and relay the server's `project.commit_result` as the
 * tool result (`committed`, `commit_conflict`, `nothing_to_commit`, `pending_approval`, or a
 * refusal such as D32's in an `auto` or scheduled run). Nothing is sent before the push
 * succeeded; any failure on the way is exactly one error answer. Like the propose broker, the
 * wire `request_id` is minted here and the frame carries the run and thread the agent knows.
 * The project is the thread's own on the server: the frame never names one.
 */
export const MAX_PENDING_COMMITS = 8;
export const MAX_PENDING_COMMITS_PER_THREAD = 1;

interface Pending {
  readonly threadId: string;
  readonly runId: string;
  readonly extensionId: string;
  readonly reply: (response: KobeToolsResponse) => void;
}

export interface ProjectCommitBrokerDeps {
  /** Send a frame now; false when the wire is not ready. */
  readonly send: (frame: ProjectCommitFrame) => boolean;
  /** Push every local change now (WorkspaceSync.pushAll). */
  readonly push: () => Promise<unknown>;
  /**
   * Whether the run's `run.start.project.access` was `write` (defence in depth: kobe-tools lists
   * the tool only then, and the server decides anyway).
   */
  readonly canCommit: (runId: string) => boolean;
}

type CommitRequest = Extract<KobeToolsRequest, { op: "project.commit" }>;

export class ProjectCommitBroker {
  readonly #deps: ProjectCommitBrokerDeps;
  readonly #pending = new Map<string, Pending>();
  #next = 1;

  constructor(deps: ProjectCommitBrokerDeps) {
    this.#deps = deps;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  commit(
    threadId: string,
    runId: string | undefined,
    request: CommitRequest,
    reply: (response: KobeToolsResponse) => void,
  ): void {
    if (runId === undefined) {
      reply(toolsError(request.id, "not_allowed", "no active run on this thread"));
      return;
    }
    if (!this.#deps.canCommit(runId)) {
      reply(toolsError(request.id, "not_allowed", "you can read this project but not change it"));
      return;
    }
    const perThread = [...this.#pending.values()].filter((p) => p.threadId === threadId).length;
    if (this.#pending.size >= MAX_PENDING_COMMITS || perThread >= MAX_PENDING_COMMITS_PER_THREAD) {
      reply(toolsError(request.id, "unavailable", "a commit is already in progress"));
      return;
    }
    const requestId = `pc_${this.#next++}`;
    // Registered before the (slow) push, so a run that ends meanwhile answers it exactly once.
    this.#pending.set(requestId, { threadId, runId, extensionId: request.id, reply });
    void this.#run(requestId, threadId, runId, request);
  }

  async #run(requestId: string, threadId: string, runId: string, request: CommitRequest) {
    const fail = (code: string, message: string) => {
      const pending = this.#pending.get(requestId);
      if (pending === undefined) return; // already answered (run ended, connection lost)
      this.#pending.delete(requestId);
      pending.reply(toolsError(pending.extensionId, code, message));
    };
    try {
      await this.#deps.push();
      if (!this.#pending.has(requestId)) return; // answered while pushing: send nothing
      const frame: ProjectCommitFrame = {
        v: 1,
        type: "project.commit",
        request_id: requestId,
        run_id: runId,
        thread_id: threadId,
        tool_call_id: request.tool_call_id,
        tool: request.tool,
        input: request.input,
      };
      if (!this.#deps.send(frame)) fail("unavailable", "Kobe server not reachable");
    } catch (error) {
      fail(
        "not_synced",
        error instanceof PushPathError
          ? error.message
          : "the working copy could not be pushed to the Kobe server",
      );
    }
  }

  /** `project.commit_result` from the server; false when nothing waits for it. */
  onResult(frame: ProjectCommitResultFrame): boolean {
    const pending = this.#pending.get(frame.request_id);
    if (pending === undefined) return false;
    this.#pending.delete(frame.request_id);
    if (!frame.ok) {
      pending.reply({ id: pending.extensionId, ok: false, error: frame.error });
      return true;
    }
    pending.reply({ id: pending.extensionId, ok: true, op: frame.op, outcome: frame.outcome });
    return true;
  }

  failAll(message: string): void {
    this.#failWhere(() => true, message);
  }

  failRun(runId: string, message: string): void {
    this.#failWhere((p) => p.runId === runId, message);
  }

  failThread(threadId: string, message: string): void {
    this.#failWhere((p) => p.threadId === threadId, message);
  }

  #failWhere(match: (pending: Pending) => boolean, message: string): void {
    for (const [id, pending] of this.#pending) {
      if (!match(pending)) continue;
      this.#pending.delete(id);
      pending.reply(toolsError(pending.extensionId, "unavailable", message));
    }
  }
}
