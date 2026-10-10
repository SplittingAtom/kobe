/**
 * A fake Kobe server for chat tests: the Thread API, the run orchestrator and the Kobe Event Stream
 * with the real wire shapes (snake_case JSON over `fetch`, SSE resume by `starting_after` /
 * `Last-Event-ID`, 204 after the end, 410 when compacted). It follows the server's rules where the
 * UI depends on them (D14 interrupted blocks the queue, D17 queue/Stop, KOBE-34 leaf/Trash busy
 * rules) so the chat is tested over its real API client, casing layer and stream code.
 * `agent` scripts what Pi would do in a run.
 */
import type { KobeEvent, KobeEventPayload, KobeEventType } from "@kobe/protocol";
import type { EventSourceFactory, EventSourceLike } from "../stream";

type Json = Record<string, unknown>;

interface FakeThread {
  thread_id: string;
  title: string | null;
  status: "idle" | "running" | "interrupted";
  /** Stop holds the queue until the user resumes or sends (Chris's D17 decision, KOBE-26). */
  queue_paused: boolean;
  leaf_entry_id: string | null;
  deleted_at: string | null;
  last_activity_at: string;
  created_at: string;
  /** The thread's chosen model alias (KOBE-44); null = the team default. */
  model: string | null;
  /** The model the thread's agent pins (KOBE-44/47 seam); it wins over `model`. */
  agent_model?: string | null;
  /** A builder test thread (KOBE-85): the draft's agent, no version, out of the lists. */
  is_test?: boolean;
  agent_id?: string | null;
  /** What the thread detail says of the pinned agent (KOBE-122). */
  agent_name?: string | null;
  agent_status?: "active" | "suspended" | "archived" | null;
  entries: FakeEntry[];
}

/** A catalog model as `GET /v1/team/models` answers it (KOBE-40/44). */
export interface FakeTeamModel {
  readonly alias: string;
  readonly label: string | null;
  enabled: boolean;
  is_default: boolean;
}

/** An agent as `GET /v1/agents/runnable` lists it (KOBE-122). */
export interface FakeRunnableAgent {
  readonly id: string;
  readonly scope: "team" | "personal" | "gallery";
  readonly galleryKey?: string;
  readonly name: string;
  readonly description?: string;
  readonly model: string | null;
}

interface FakeEntry {
  entry_id: string;
  parent_id: string | null;
  seq: number;
  type: string;
  payload: Json;
  payload_offloaded: boolean;
  created_at: string;
}

interface FakeRun {
  run_id: string;
  thread_id: string;
  status: string;
  input: string;
  parent_entry_id: string | null;
  queue_pos: number;
  retry_of_run_id?: string;
  events: KobeEvent[];
  compacted: boolean;
  /** Last entry this run committed (where its next entry hangs). */
  tip: string | null;
  client_key?: string;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly team: string | null;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

const NOW = "2026-10-02T10:00:00.000Z";
const ACTIVE = new Set(["running", "waiting_approval"]);
const ENDED = new Set(["completed", "failed", "interrupted", "cancelled", "budget_stopped"]);

function uuid(prefix: number, n: number): string {
  return `00000000-0000-4000-8000-${String(prefix).padStart(4, "0")}${String(n).padStart(8, "0")}`;
}

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status: number, code: string, message = code): Response {
  return json(status, { code, message });
}

/** An artifact (KOBE-55 D-6): `versions[0]` is version 1. */
export interface FakeArtifact {
  id: string;
  thread_id: string;
  kind: string;
  title: string;
  language: string | null;
  versions: string[];
}

/** The frame route's CSP, as D-6 specifies it (the server, KOBE-129, sets it). */
export const FAKE_FRAME_CSP =
  "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export class FakeKobe {
  readonly teamId = uuid(1, 1);
  readonly requests: RecordedRequest[] = [];
  readonly threads = new Map<string, FakeThread>();
  readonly runs = new Map<string, FakeRun>();
  /** `GET /v1/runs/{id}/usage` answers (KOBE-43); absent: a run without model calls. */
  readonly usage = new Map<string, Json>();
  /** `GET /v1/team/budgets/status` (KOBE-42). */
  budgetStatus: Json = { state: "ok", lines: [] };
  /** Requests answered with an error once, keyed "METHOD /path" (e.g. to simulate a 503). */
  readonly failNext = new Map<string, Response>();
  /** The caller's workspace (KOBE-194): path (no leading slash) -> bytes; listed per folder. */
  readonly workspaceFiles = new Map<string, Uint8Array>();
  /** Folders listed so far (`GET /v1/workspace/files`), to assert one request per thread. */
  readonly workspaceListings: string[] = [];
  /** The install catalog with the team's choice (KOBE-44); empty = no models route answers. */
  readonly teamModels: FakeTeamModel[] = [];
  /** `GET /v1/agents/runnable` (KOBE-122), in this order; `runnablePageSize` pages it. */
  readonly runnableAgents: FakeRunnableAgent[] = [];
  runnablePageSize = 200;
  /** The server holds the queue after Stop (KOBE-26); false = the KOBE-30 behaviour (next starts). */
  pauseOnStop = true;
  #threadN = 0;
  #runN = 0;
  #entryN = 0;
  #queueN = 0;
  readonly #sources = new Set<FakeEventSource>();
  /** Approvals asked with `requestApproval` (KOBE-37), by id. */
  readonly approvals = new Map<
    string,
    { runId: string; payload: KobeEventPayload<"approval.requested">; status: string }
  >();

  /** Request-access requests (KOBE-39), newest last; `enabled`: domains already enabled. */
  readonly egressRequests: Json[] = [];
  readonly enabledDomains = new Set<string>();

  /** Artifacts of `GET /v1/artifacts*` (KOBE-55 D-6), by id. */
  readonly artifacts = new Map<string, FakeArtifact>();
  #artifactN = 0;

  /** Shared files of `GET /v1/files/:id/content` (KOBE-150), by id; `status` makes the download fail. */
  readonly sharedFiles = new Map<string, { readonly bytes: Uint8Array; readonly status: number }>();

  // --- setup ----------------------------------------------------------------------------------

  /** An artifact that exists before the test; `versions` are the contents of v1, v2, ... */
  addArtifact(
    threadId: string,
    a: {
      readonly kind: string;
      readonly title: string;
      readonly versions: readonly string[];
      readonly language?: string;
    },
  ): string {
    this.#artifactN += 1;
    const id = uuid(7, this.#artifactN);
    this.artifacts.set(id, {
      id,
      thread_id: threadId,
      kind: a.kind,
      title: a.title,
      language: a.language ?? null,
      versions: [...a.versions],
    });
    return id;
  }

  /** A file `share_file` made; the download answers `status` (200 serves `bytes`). */
  addSharedFile(bytes: Uint8Array, status = 200): string {
    const id = uuid(8, this.sharedFiles.size + 1);
    this.sharedFiles.set(id, { bytes, status });
    return id;
  }

  addThread(title: string | null = null): string {
    this.#threadN += 1;
    const id = uuid(2, this.#threadN);
    this.threads.set(id, {
      thread_id: id,
      title,
      status: "idle",
      leaf_entry_id: null,
      queue_paused: false,
      deleted_at: null,
      last_activity_at: `2026-10-02T09:${String(this.#threadN).padStart(2, "0")}:00.000Z`,
      created_at: NOW,
      model: null,
      entries: [],
    });
    return id;
  }

  /** Adds a committed entry directly (history that exists before the test). */
  addEntry(
    threadId: string,
    parentId: string | null,
    message: Json,
    opts: { leaf?: boolean } = {},
  ) {
    const thread = this.#thread(threadId);
    this.#entryN += 1;
    const id = `e${this.#entryN}`;
    thread.entries.push({
      entry_id: id,
      parent_id: parentId,
      seq: thread.entries.length + 1,
      type: "message",
      payload: { type: "message", id, parentId, timestamp: NOW, message },
      payload_offloaded: false,
      created_at: NOW,
    });
    if (opts.leaf !== false) thread.leaf_entry_id = id;
    return id;
  }

  #thread(id: string): FakeThread {
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`no thread ${id}`);
    return thread;
  }

  run(runId: string): FakeRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no run ${runId}`);
    return run;
  }

  latestRun(threadId: string): FakeRun {
    const runs = [...this.runs.values()].filter((r) => r.thread_id === threadId);
    const run = runs.at(-1);
    if (!run) throw new Error(`no run on ${threadId}`);
    return run;
  }

  activeRun(threadId: string): FakeRun | undefined {
    return [...this.runs.values()].find((r) => r.thread_id === threadId && ACTIVE.has(r.status));
  }

  // --- the agent (what Pi does inside a run) -----------------------------------------------------

  /** The server asks the run's user (KOBE-37): records the approval and emits the card event. */
  requestApproval(runId: string, payload: KobeEventPayload<"approval.requested">): void {
    this.approvals.set(payload.approval_id, { runId, payload, status: "pending" });
    this.run(runId).status = "waiting_approval";
    this.emit(runId, "approval.requested", payload);
  }

  emit<T extends KobeEventType>(runId: string, type: T, payload: KobeEventPayload<T>): void {
    const run = this.run(runId);
    const event = {
      run_id: runId,
      seq: run.events.length + 1,
      ts: NOW,
      type,
      payload,
    } as KobeEvent;
    run.events.push(event);
    for (const source of this.#sources) source.deliver(run);
  }

  readonly agent = {
    delta: (runId: string, messageId: string, delta: string, contentIndex = 0) =>
      this.emit(runId, "text.delta", { message_id: messageId, content_index: contentIndex, delta }),
    toolCall: (runId: string, toolCallId: string, tool: string, input: Json, messageId?: string) =>
      this.emit(runId, "tool.call", {
        tool_call_id: toolCallId,
        tool,
        input: input as never,
        risk: "write",
        ...(messageId ? { message_id: messageId } : {}),
      }),
    toolResult: (
      runId: string,
      toolCallId: string,
      tool: string,
      preview: string,
      isError = false,
    ) =>
      this.emit(runId, "tool.result", {
        tool_call_id: toolCallId,
        tool,
        is_error: isError,
        preview,
        truncated: false,
      }),
    commit: (runId: string, message: Json, messageId?: string) => {
      const run = this.run(runId);
      const thread = this.#thread(run.thread_id);
      const parentId = run.tip ?? run.parent_entry_id;
      const entryId = this.addEntry(run.thread_id, parentId, message, { leaf: false });
      run.tip = entryId;
      const entry = thread.entries.at(-1) as FakeEntry;
      this.emit(runId, "entry.committed", {
        entry_id: entryId,
        parent_id: parentId,
        entry_type: "message",
        ...(messageId ? { message_id: messageId } : {}),
        payload: entry.payload as never,
      });
      return entryId;
    },
    commitPrompt: (runId: string) =>
      this.agent.commit(runId, { role: "user", content: this.run(runId).input }),
    complete: (runId: string) => {
      const run = this.run(runId);
      // Like the server: the leaf moves in the same transaction as the terminal event.
      this.#thread(run.thread_id).leaf_entry_id =
        run.tip ?? this.#thread(run.thread_id).leaf_entry_id;
      this.#end(run, "completed", "run.completed", { leaf_entry_id: run.tip });
      this.#advance(run.thread_id);
    },
    fail: (runId: string, code: string, message: string) => {
      this.#end(this.run(runId), "failed", "run.failed", { error: { code, message } });
      this.#advance(this.run(runId).thread_id);
    },
    /** The sandbox died mid-run (D14): interrupted, Retry offered, the queue waits. */
    loseSandbox: (runId: string) => {
      const run = this.run(runId);
      this.#end(run, "interrupted", "run.interrupted", {
        reason: "sandbox_lost",
        last_entry_id: run.tip,
        retryable: true,
      });
    },
  };

  /** Ends a run: state first, then the terminal event (one transaction on the server). */
  #end<T extends KobeEventType>(
    run: FakeRun,
    status: string,
    type: T,
    payload: KobeEventPayload<T>,
  ) {
    const thread = this.#thread(run.thread_id);
    const wasActive = ACTIVE.has(run.status);
    run.status = status;
    if (wasActive) thread.status = status === "interrupted" ? "interrupted" : "idle";
    this.emit(run.run_id, type, payload);
  }

  #start(run: FakeRun): void {
    run.status = "running";
    const thread = this.#thread(run.thread_id);
    thread.status = "running";
    run.parent_entry_id ??= thread.leaf_entry_id;
    this.emit(run.run_id, "run.started", {
      thread_id: run.thread_id,
      agent_id: null,
      agent_version: null,
      ...(run.retry_of_run_id ? { retry_of_run_id: run.retry_of_run_id } : {}),
    });
  }

  /** Starts the next queued run if the thread may advance (idle, nothing active). */
  #advance(threadId: string): void {
    const thread = this.#thread(threadId);
    if (thread.status !== "idle" || thread.queue_paused || this.activeRun(threadId)) return;
    const next = this.#queued(threadId)[0];
    if (next) this.#start(next);
  }

  #queued(threadId: string): FakeRun[] {
    return [...this.runs.values()]
      .filter((r) => r.thread_id === threadId && r.status === "queued")
      .sort(
        (a, b) =>
          (a.retry_of_run_id ? -1 : 0) - (b.retry_of_run_id ? -1 : 0) || a.queue_pos - b.queue_pos,
      );
  }

  #snapshot(run: FakeRun): Json {
    const queued = this.#queued(run.thread_id);
    const rank = queued.indexOf(run);
    return {
      run_id: run.run_id,
      thread_id: run.thread_id,
      team_id: this.teamId,
      status: run.status,
      trigger: "user",
      approval_mode: "ask-on-write",
      ...(rank >= 0 ? { queue_pos: rank + 1 } : {}),
      ...(run.retry_of_run_id ? { retry_of_run_id: run.retry_of_run_id } : {}),
    };
  }

  #summary(thread: FakeThread): Json {
    const { entries: _e, agent_model: _a, agent_name: _n, agent_status: _s, ...rest } = thread;
    return {
      ...rest,
      owner_user_id: uuid(3, 1),
      project_id: null,
      agent_id: thread.agent_id ?? null,
      agent_version: null,
      is_test: thread.is_test ?? false,
      shared_to_project: false,
      purge_after: thread.deleted_at === null ? null : "2026-11-01T10:00:00.000Z",
    };
  }

  #threadRuns(threadId: string): Json {
    const active = this.activeRun(threadId);
    const interrupted =
      this.#thread(threadId).status === "interrupted"
        ? [...this.runs.values()]
            .filter((r) => r.thread_id === threadId && r.status === "interrupted")
            .at(-1)
        : undefined;
    return {
      runs: [...(active ? [active] : []), ...this.#queued(threadId)].map((r) => this.#snapshot(r)),
      interrupted_run: interrupted ? this.#snapshot(interrupted) : null,
      ...(this.pauseOnStop ? { queue_paused: this.#thread(threadId).queue_paused } : {}),
    };
  }

  // --- HTTP -----------------------------------------------------------------------------------

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input), "http://kobe.test");
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body =
      typeof init.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
    this.requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      team: headers.get("x-kobe-team"),
      idempotencyKey: headers.get("idempotency-key"),
      body,
    });
    const key = `${method} ${url.pathname}`;
    const forced = this.failNext.get(key);
    if (forced) {
      this.failNext.delete(key);
      return forced;
    }
    if (url.pathname === "/v1/me/teams") {
      return json(200, {
        activeTeamId: this.teamId,
        teams: [{ id: this.teamId, slug: "fin", name: "Finance", role: "member" }],
      });
    }
    if (url.pathname === "/v1/me/invites") return json(200, { invitations: [] });
    if (url.pathname === "/v1/team/models" && this.teamModels.length > 0) {
      if (headers.get("x-kobe-team") !== this.teamId) return error(409, "team_mismatch");
      const models = this.teamModels.map((m) => ({
        ...m,
        provider_id: "ollama",
        model: m.alias,
        gateway_model: `ollama/${m.alias}`,
        created_at: NOW,
        updated_at: NOW,
      }));
      return json(200, {
        models,
        default: this.teamModels.find((m) => m.is_default)?.alias ?? null,
      });
    }
    if (url.pathname === "/v1/agents/runnable") {
      if (headers.get("x-kobe-team") !== this.teamId) return error(409, "team_mismatch");
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const page = this.runnableAgents.slice(start, start + this.runnablePageSize);
      const next = start + page.length;
      return json(200, {
        agents: page.map((a) => ({
          slug: a.name.toLowerCase().replace(/\W+/g, "-"),
          current_version: 1,
          ...a,
        })),
        next_cursor: next < this.runnableAgents.length ? String(next) : null,
      });
    }
    if (url.pathname.startsWith("/v1/artifacts")) return this.#artifactRoute(url, headers);
    if (url.pathname === "/v1/workspace/files" && method === "GET") {
      const dir = url.searchParams.get("path") ?? "";
      this.workspaceListings.push(dir);
      const entries = [...this.workspaceFiles]
        .filter(([path]) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"))
        .map(([path, bytes]) => ({
          name: path.split("/").at(-1),
          path,
          type: "file",
          size_bytes: bytes.length,
          mtime: NOW,
          source: "synced",
          owner: "server",
          area: "uploads",
        }));
      return json(200, { path: dir, entries });
    }
    if (url.pathname === "/v1/workspace/file" && method === "GET") {
      const bytes = this.workspaceFiles.get(url.searchParams.get("path") ?? "");
      if (!bytes) return error(404, "not_found");
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    const shared = /^\/v1\/files\/([^/]+)\/content$/u.exec(url.pathname);
    if (shared) {
      const file = this.sharedFiles.get(shared[1] ?? "");
      if (!file) return error(404, "not_found");
      if (file.status !== 200) return error(file.status, "unavailable");
      return new Response(new Uint8Array(file.bytes), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (url.pathname.startsWith("/v1/memory/")) return this.#memoryRoute(method, url, headers);
    const scoped =
      url.pathname === "/v1/team/budgets/status" ||
      url.pathname.startsWith("/v1/threads") ||
      url.pathname.startsWith("/v1/runs") ||
      url.pathname.startsWith("/v1/approvals") ||
      url.pathname === "/v1/team/retention" ||
      url.pathname.startsWith("/v1/egress/requests");
    if (!scoped) return error(404, "not_found");
    if (headers.get("x-kobe-team") !== this.teamId) return error(409, "team_mismatch");
    return this.#route(method, url, body as Json | undefined, headers);
  };

  /**
   * `/v1/memory/:id` (KOBE-155) for the Undo chip: DELETE answers 204, `POST .../restore` the doc
   * at the asked version. Both are recorded in `requests`; `failNext` makes one fail.
   */
  #memoryRoute(method: string, url: URL, headers: Headers): Response {
    if (headers.get("x-kobe-team") !== this.teamId) return error(409, "team_mismatch");
    const [, , id, leaf] = url.pathname.split("/").filter(Boolean); // v1 memory id restore
    if (method === "DELETE" && id && leaf === undefined) return new Response(null, { status: 204 });
    if (method === "POST" && id && leaf === "restore") {
      return json(200, {
        id,
        scope: "user",
        path: "notes.md",
        current_version: 3,
        size_bytes: 1,
        updated_at: NOW,
        updated_by: null,
        content: "",
        versions: [],
      });
    }
    return error(404, "not_found");
  }

  #artifactRoute(url: URL, headers: Headers): Response {
    const [, , id, , n, leaf] = url.pathname.split("/").filter(Boolean); // v1 artifacts id versions n leaf
    const isFrame = leaf === "frame";
    const team = isFrame ? url.searchParams.get("team") : headers.get("x-kobe-team");
    // Downloads (content with ?team=) also carry the team in the query.
    const teamOk = team === this.teamId || url.searchParams.get("team") === this.teamId;
    if (!teamOk) return error(409, "team_mismatch");
    const summary = (a: FakeArtifact) => ({
      id: a.id,
      thread_id: a.thread_id,
      kind: a.kind,
      title: a.title,
      language: a.language,
      current_version: a.versions.length,
      created_at: NOW,
      updated_at: NOW,
    });
    if (id === undefined) {
      const threadId = url.searchParams.get("thread_id");
      const list = [...this.artifacts.values()].filter((a) => a.thread_id === threadId);
      return json(200, { artifacts: list.map(summary) });
    }
    const artifact = this.artifacts.get(id);
    if (!artifact) return error(404, "not_found");
    if (n === undefined) {
      const versions = artifact.versions.map((c, i) => ({
        version: i + 1,
        size_bytes: new TextEncoder().encode(c).length,
        created_at: NOW,
      }));
      return json(200, { ...summary(artifact), versions });
    }
    const content = artifact.versions[Number(n) - 1];
    if (content === undefined) return error(404, "not_found");
    if (isFrame) {
      if (artifact.kind !== "html" && artifact.kind !== "svg") return error(404, "not_found");
      return new Response(content, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": FAKE_FRAME_CSP,
          "x-frame-options": "SAMEORIGIN",
          "referrer-policy": "no-referrer",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return new Response(content, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="${artifact.title}-v${n}.txt"`,
      },
    });
  }

  /** The team's next retention shortening (KOBE-18 banner); null: none. */
  upcomingRetention: { period: string; effective_at: string } | null = null;

  #route(method: string, url: URL, body: Json | undefined, headers: Headers): Response {
    if (url.pathname === "/v1/team/budgets/status" && method === "GET") {
      return json(200, this.budgetStatus);
    }
    const parts = url.pathname.split("/").filter(Boolean); // v1, threads|runs, id, action
    const [, area, id, action, sub] = parts;
    if (area === "threads") return this.#threadRoute(method, id, action, sub, url, body, headers);
    if (area === "runs" && id) return this.#runRoute(method, id, action, body);
    if (area === "approvals" && id) return this.#approvalRoute(method, id, body);
    if (area === "egress" && id === "requests") return this.#egressRoute(method, url, body);
    if (area === "team" && id === "retention" && method === "GET") {
      return json(200, {
        period: "forever",
        maximum: "forever",
        effective: "forever",
        pending: null,
        upcoming: this.upcomingRetention,
        allowed: ["30d", "90d", "1y", "forever"],
      });
    }
    return error(404, "not_found");
  }

  /** `/v1/egress/requests` (KOBE-39): the member's own requests; one pending per domain. */
  #egressRoute(method: string, url: URL, body: Json | undefined): Response {
    if (method === "GET") {
      const domain = url.searchParams.get("domain");
      return json(200, {
        requests: this.egressRequests
          .filter((r) => domain === null || r.domain === domain)
          .reverse(),
      });
    }
    const domain = String(body?.domain ?? "");
    if (this.enabledDomains.has(domain)) {
      return error(
        409,
        "already_enabled",
        `${domain} is already enabled for your team. Try again.`,
      );
    }
    const pending = this.egressRequests.find((r) => r.domain === domain && r.status === "pending");
    if (pending) return json(200, { request: pending });
    const request: Json = {
      id: uuid(9, this.egressRequests.length + 1),
      domain,
      pattern: domain,
      status: "pending",
      thread_id: body?.thread_id ?? null,
      requested_by: { id: uuid(8, 1), name: "Member" },
      decided_by: null,
      created_at: NOW,
      decided_at: null,
    };
    this.egressRequests.push(request);
    return json(201, { request });
  }

  /** `GET`/`POST /v1/approvals/{id}`: a decision resolves the card through the stream. */
  #approvalRoute(method: string, id: string, body: Json | undefined): Response {
    const approval = this.approvals.get(id);
    if (!approval) return error(404, "approval_not_found", "No pending approval with that id.");
    const view = () => ({
      ...approval.payload,
      run_id: approval.runId,
      status: approval.status,
      remembered: false,
    });
    if (method === "GET") return json(200, view());
    if (approval.status !== "pending") {
      return error(409, "approval_resolved", `This approval is already ${approval.status}.`);
    }
    const allow = body?.decision === "allow";
    approval.status = allow ? "allowed" : "denied";
    this.run(approval.runId).status = "running";
    this.emit(approval.runId, "approval.resolved", {
      approval_id: id,
      tool_call_id: approval.payload.tool_call_id,
      decision: allow ? "allowed" : "denied",
      cause: "user",
      remembered: allow && body?.remember !== undefined,
    });
    return json(200, view());
  }

  #threadRoute(
    method: string,
    id: string | undefined,
    action: string | undefined,
    sub: string | undefined,
    url: URL,
    body: Json | undefined,
    headers: Headers,
  ): Response {
    if (id === undefined && method === "GET") {
      const q = url.searchParams.get("q");
      const list = [...this.threads.values()]
        .filter((t) => t.deleted_at === null && t.is_test !== true)
        .filter((t) => q === null || (t.title ?? "").toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
      const threads = list.map((t) =>
        q === null
          ? this.#summary(t)
          : {
              ...this.#summary(t),
              matched_entry_id: null,
              snippet: [{ text: t.title, highlight: true }],
              score: 1,
            },
      );
      return json(200, { threads, next_cursor: null });
    }
    if (id === "trash" && method === "GET") {
      const trash = [...this.threads.values()].filter((t) => t.deleted_at !== null);
      return json(200, { threads: trash.map((t) => this.#summary(t)), next_cursor: null });
    }
    if (id === "test" && method === "DELETE") {
      const agent = url.searchParams.get("agent_id");
      const mine = [...this.threads.values()].filter(
        (t) =>
          t.is_test === true && t.deleted_at === null && (agent === null || t.agent_id === agent),
      );
      for (const t of mine) t.deleted_at = NOW;
      return json(200, { cleared: mine.length });
    }
    if (id === undefined && method === "POST") {
      const model = (body?.model as string | null | undefined) ?? null;
      if (model !== null && !this.#modelEnabled(model)) return this.#modelNotEnabled();
      const threadId = this.addThread((body?.title as string | undefined) ?? null);
      this.#thread(threadId).model = model;
      if (body?.test === true) {
        Object.assign(this.#thread(threadId), { is_test: true, agent_id: body.agent_id ?? null });
      } else if (typeof body?.agent_id === "string") {
        const agent = this.runnableAgents.find((a) => a.id === body.agent_id);
        if (!agent) return error(404, "agent_not_found", "No agent with that id.");
        Object.assign(this.#thread(threadId), {
          agent_id: agent.id,
          agent_model: agent.model,
          agent_name: agent.name,
          agent_status: "active",
        });
      }
      return json(201, this.#summary(this.#thread(threadId)));
    }
    const thread = id === undefined ? undefined : this.threads.get(id);
    if (!thread) return error(404, "thread_not_found", "No thread with that id.");
    if (action === undefined) return this.#threadItself(method, thread, url, body);
    if (action === "entries") return json(200, this.#entryPage(thread, url));
    if (action === "leaf") {
      if (this.activeRun(thread.thread_id)) return error(409, "thread_busy", "The thread is busy.");
      thread.leaf_entry_id = String(body?.entry_id);
      return json(200, this.#summary(thread));
    }
    if (action === "restore") {
      thread.deleted_at = null;
      return json(200, this.#summary(thread));
    }
    if (action === "purge" && method === "POST") {
      if (thread.deleted_at === null) return error(409, "not_in_trash", "Move it to Trash first.");
      this.threads.delete(thread.thread_id);
      return new Response(null, { status: 204 });
    }
    if (action === "messages") return this.#submit(thread, body, headers.get("idempotency-key"));
    if (action === "runs") return json(200, this.#threadRuns(thread.thread_id));
    if (action === "pending-messages") return json(200, this.#pending(thread.thread_id));
    if (action === "queue" && sub === "resume") {
      if (thread.status === "interrupted") thread.status = "idle";
      thread.queue_paused = false;
      this.#advance(thread.thread_id);
      return json(200, this.#threadRuns(thread.thread_id));
    }
    return error(404, "not_found");
  }

  #threadItself(method: string, thread: FakeThread, url: URL, body: Json | undefined): Response {
    if (method === "GET") {
      const page = this.#entryPage(thread, url);
      return json(200, {
        ...this.#summary(thread),
        agent_current_version: null,
        agent_model: thread.agent_model ?? null,
        agent_name: thread.agent_name ?? null,
        agent_status: thread.agent_status ?? null,
        ...page,
      });
    }
    if (method === "PATCH") {
      if (body && "model" in body) {
        const model = (body.model as string | null) ?? null;
        if (model !== null && model !== thread.model && !this.#modelEnabled(model)) {
          return this.#modelNotEnabled();
        }
        thread.model = model;
      }
      if (body && "title" in body) thread.title = (body.title as string | null) ?? null;
      return json(200, this.#summary(thread));
    }
    if (method === "DELETE") {
      const busy = this.activeRun(thread.thread_id) || this.#queued(thread.thread_id).length > 0;
      if (busy) return error(409, "thread_busy", "Stop the run and clear the queue first.");
      thread.deleted_at = NOW;
      return json(200, this.#summary(thread));
    }
    return error(405, "method_not_allowed");
  }

  #modelEnabled(alias: string): boolean {
    return this.teamModels.some((m) => m.alias === alias && m.enabled);
  }

  #modelNotEnabled(): Response {
    return error(
      409,
      "model_not_enabled",
      "That model isn't enabled for your team. Pick one of the team's models, or ask a team admin.",
    );
  }

  #entryPage(thread: FakeThread, url: URL): Json {
    const after = Number(url.searchParams.get("after") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "200");
    const rest = thread.entries.filter((e) => e.seq > after);
    const page = rest.slice(0, limit);
    return {
      entries: page,
      next_entries_after: rest.length > limit ? (page.at(-1)?.seq ?? null) : null,
    };
  }

  #pending(threadId: string): Json {
    const active = this.activeRun(threadId);
    const runs = [...(active ? [active] : []), ...this.#queued(threadId)];
    return {
      messages: runs.map((r) => ({
        run_id: r.run_id,
        status: r.status,
        ...(this.#snapshot(r).queue_pos === undefined
          ? {}
          : { queue_pos: this.#snapshot(r).queue_pos }),
        content: r.input,
        parent_entry_id: r.parent_entry_id,
      })),
    };
  }

  #submit(thread: FakeThread, body: Json | undefined, key: string | null): Response {
    if (thread.deleted_at !== null) return error(409, "thread_in_trash");
    const repeat = [...this.runs.values()].find((r) => key !== null && r.client_key === key);
    if (repeat) return json(201, { run_id: repeat.run_id, queued: repeat.status === "queued" });
    this.#runN += 1;
    this.#queueN += 1;
    const run: FakeRun = {
      run_id: uuid(4, this.#runN),
      thread_id: thread.thread_id,
      status: "queued",
      input: String(body?.content ?? ""),
      parent_entry_id: (body?.parent_entry_id as string | undefined) ?? null,
      queue_pos: this.#queueN,
      events: [],
      compacted: false,
      tip: null,
      ...(key ? { client_key: key } : {}),
    };
    this.runs.set(run.run_id, run);
    thread.last_activity_at = new Date(Date.parse(thread.last_activity_at) + 60_000).toISOString();
    if (thread.queue_paused) {
      // Sending releases a held queue: the held messages run first, then this one.
      thread.queue_paused = false;
      this.#advance(thread.thread_id);
    }
    const waits = this.activeRun(thread.thread_id) !== undefined || thread.status === "interrupted";
    if (waits) {
      this.emit(run.run_id, "run.queued", {
        thread_id: thread.thread_id,
        trigger: "user",
        queue_pos: this.#queued(thread.thread_id).length,
      });
    } else this.#start(run);
    return json(201, { run_id: run.run_id, queued: waits });
  }

  #runRoute(
    method: string,
    id: string,
    action: string | undefined,
    body: Json | undefined,
  ): Response {
    const run = this.runs.get(id);
    if (!run) return error(404, "run_not_found", "No run with that id.");
    if (action === undefined && method === "GET") return json(200, this.#snapshot(run));
    if (action === "usage" && method === "GET") {
      return json(
        200,
        this.usage.get(id) ?? {
          run_id: id,
          models: [],
          calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd: 0,
          unpriced_calls: 0,
          estimated_calls: 0,
        },
      );
    }
    if (action === undefined && method === "PATCH") {
      if (run.status !== "queued") return error(409, "invalid_transition");
      run.input = String(body?.content);
      return json(200, this.#snapshot(run));
    }
    if (action === "steer") {
      if (!ACTIVE.has(run.status))
        return error(409, "invalid_transition", "The run already ended.");
      this.emit(run.run_id, "steer.applied", { content: String(body?.content) });
      return json(200, this.#snapshot(run));
    }
    if (action === "cancel") return this.#cancel(run);
    if (action === "retry") return this.#retry(run);
    return error(404, "not_found");
  }

  #cancel(run: FakeRun): Response {
    if (run.status === "queued") {
      run.status = "cancelled";
      return json(200, this.#snapshot(run));
    }
    if (!ACTIVE.has(run.status)) return json(200, this.#snapshot(run));
    const thread = this.#thread(run.thread_id);
    if (this.pauseOnStop && this.#queued(run.thread_id).length > 0) thread.queue_paused = true;
    this.#end(run, "cancelled", "run.interrupted", {
      reason: "cancelled",
      last_entry_id: run.tip,
      retryable: false,
    });
    this.#advance(run.thread_id);
    return json(200, this.#snapshot(run));
  }

  #retry(run: FakeRun): Response {
    const thread = this.#thread(run.thread_id);
    if (run.status !== "interrupted" || thread.status !== "interrupted") {
      return error(409, "invalid_transition", "Only an interrupted run can be retried.");
    }
    this.#runN += 1;
    const retry: FakeRun = {
      run_id: uuid(4, this.#runN),
      thread_id: run.thread_id,
      status: "queued",
      input: run.input,
      parent_entry_id: run.parent_entry_id,
      queue_pos: 0,
      retry_of_run_id: run.run_id,
      events: [],
      compacted: false,
      tip: null,
    };
    this.runs.set(retry.run_id, retry);
    thread.status = "idle";
    this.#start(retry);
    return json(201, { run_id: retry.run_id, queued: false });
  }

  // --- SSE ------------------------------------------------------------------------------------

  /** Open event streams (tests check what the browser is connected to). */
  get openStreams(): readonly FakeEventSource[] {
    return [...this.#sources].filter((s) => s.readyState !== 2);
  }

  readonly eventSource: EventSourceFactory = (url) => {
    const parsed = new URL(url, "http://kobe.test");
    const runId = parsed.pathname.split("/")[3] ?? "";
    const after = Number(parsed.searchParams.get("starting_after") ?? "0");
    const source = new FakeEventSource(this, runId, after, () => this.#sources.delete(source));
    this.#sources.add(source);
    this.requests.push({
      method: "SSE",
      path: `${parsed.pathname}${parsed.search}`,
      team: null,
      idempotencyKey: null,
      body: undefined,
    });
    queueMicrotask(() => source.connect());
    return source;
  };

  /** Drops every open stream's connection; the browser reconnects with Last-Event-ID. */
  dropConnections(): void {
    for (const source of this.#sources) source.drop();
  }

  isEnded(run: FakeRun): boolean {
    return ENDED.has(run.status);
  }
}

/**
 * EventSource as the browser and KOBE-31's server behave together: replay `seq > cursor`, then
 * live events; after a terminal event the server ends the response; a reconnect sends
 * `Last-Event-ID` and gets 204 (ended, nothing new) or 410 (compacted), which close the source.
 */
export class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly #listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  readonly #server: FakeKobe;
  readonly runId: string;
  readonly startingAfter: number;
  #lastEventId = 0;
  readonly #onClose: () => void;
  /** Connections made (1 + reconnects). */
  connections = 0;

  constructor(server: FakeKobe, runId: string, startingAfter: number, onClose: () => void) {
    this.#server = server;
    this.runId = runId;
    this.startingAfter = startingAfter;
    this.#onClose = onClose;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = 2;
    this.#onClose();
  }

  #cursor(): number {
    return Math.max(this.startingAfter, this.#lastEventId);
  }

  connect(): void {
    if (this.readyState === 2) return;
    this.connections += 1;
    const run = this.#server.runs.get(this.runId);
    const last = run?.events.length ?? 0;
    const refused =
      run === undefined || run.compacted || (this.#server.isEnded(run) && this.#cursor() >= last);
    if (refused) {
      // 404, 410 or 204: EventSource fails the connection for good.
      this.readyState = 2;
      this.#onClose();
      this.onerror?.(new Event("error"));
      return;
    }
    this.readyState = 1;
    this.onopen?.(new Event("open"));
    this.deliver(run);
  }

  /** Sends every event after the cursor (the server re-reads Postgres on each hint). */
  deliver(run: { run_id: string; events: readonly KobeEvent[] }): void {
    if (this.readyState !== 1 || run.run_id !== this.runId) return;
    for (const event of run.events) {
      if (event.seq <= this.#cursor() || this.readyState !== 1) continue;
      this.#lastEventId = event.seq;
      const message = new MessageEvent<string>(event.type, {
        data: JSON.stringify(event),
        lastEventId: String(event.seq),
      });
      for (const listener of this.#listeners.get(event.type) ?? []) listener(message);
      if (
        event.type.startsWith("run.") &&
        event.type !== "run.queued" &&
        event.type !== "run.started"
      ) {
        this.drop(); // the server ends the response after a terminal event
        return;
      }
    }
  }

  /** The connection drops; the browser reconnects (Last-Event-ID) on the next tick. */
  drop(): void {
    if (this.readyState !== 1) return;
    this.readyState = 0;
    this.onerror?.(new Event("error"));
    setTimeout(() => this.connect(), 0);
  }

  /** A reconnect that replays from an older cursor (duplicates the client must drop). */
  rewind(to: number): void {
    this.#lastEventId = to;
  }
}
