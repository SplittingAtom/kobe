/**
 * The fd-4 channel between the kobe-tools Pi extension and kobe-sandbox-agent (sandbox-internal; the
 * agent side is `tools/channel.ts`; shapes agreed in packages/protocol `artifacts.ts`, KOBE-127).
 * JSONL, LF-split, one JSON object per line, same framing and fail-closed rules as the policy
 * channel.
 *
 *   extension → agent   {"id","op":"artifact.put","tool_call_id","tool","input"}
 *                       {"id","op":"file.share","tool_call_id","tool":"share_file","input"}
 *                       {"id","op":"project.commit","tool_call_id","tool":"commit_project","input"}
 *                       {"id","op":"skill.draft_save","tool_call_id","tool":"save_skill_draft","input"}
 *                       {"id","op":"file.edit_propose","tool_call_id","tool":"propose_file_edit","input"}
 *                       {"id","op":"file.open","tool_call_id","tool":"open_file","input"}
 *   agent → extension   {"id","ok":true,"artifact_id","version"}            (artifact.put)
 *                       {"id","ok":true,"file_id","name","mime_type","size_bytes","scan",
 *                        "created_at","sha256"}                              (file.share)
 *                       {"id","ok":false,"error":{"code","message"}}
 *
 * Every op has its own `op` string; `remember` / `recall` (KOBE-157) use `memory.put` / `memory.read`, registered only when the agent sets
 * {@link TOOLS_MEMORY_ENV}. `share_file` (KOBE-149) is registered only when the agent sets
 * {@link TOOLS_FILES_ENV} (it announced the `files` capability; the server may then answer it).
 *
 * Dependency-free (node builtins only): the extension ships on its own, root-owned, without
 * node_modules. The values below mirror packages/protocol `artifacts.ts`; a test pins them.
 */
export const EXTENSION_NAME = "kobe-tools";

/** Env var naming the inherited channel fd. Read once at load and removed from `process.env`. */
export const TOOLS_FD_ENV = "KOBE_TOOLS_FD";
export const TOOLS_FD = 4;
export const TOOLS_TIMEOUT_MS = 30_000;

export const OP_ARTIFACT_PUT = "artifact.put";
export const OP_FILE_SHARE = "file.share";
export const OP_PROJECT_COMMIT = "project.commit";
export const OP_MEMORY_PUT = "memory.put";
export const OP_MEMORY_READ = "memory.read";
export const OP_SKILL_DRAFT_SAVE = "skill.draft_save";
export const OP_FILE_EDIT_PROPOSE = "file.edit_propose";
export const OP_FILE_OPEN = "file.open";
export const OP_NOTEBOOK_RUN = "notebook.run";
export const OPS = [
  OP_ARTIFACT_PUT,
  OP_FILE_SHARE,
  OP_PROJECT_COMMIT,
  OP_MEMORY_PUT,
  OP_MEMORY_READ,
  OP_SKILL_DRAFT_SAVE,
  OP_FILE_EDIT_PROPOSE,
  OP_FILE_OPEN,
  OP_NOTEBOOK_RUN,
] as const;

/** Env var set to `1` by an agent that announced the `memory` capability. Read once, removed. */
export const TOOLS_MEMORY_ENV = "KOBE_TOOLS_MEMORY";
/** Env var naming the per-run memory file (memory-hooks.ts). Read once, removed. */
export const MEMORY_FILE_ENV = "KOBE_MEMORY_FILE";
export const TOOL_REMEMBER = "remember";
export const TOOL_RECALL = "recall";
/** Mirrors packages/protocol `memory.ts` (pinned by a test). */
export const MEMORY_FILE_MAX_BYTES = 64 * 1024;
export const MEMORY_PATH_MAX = 200;
export const MEMORY_QUERY_MAX = 500;
export const MEMORY_RECALL_MAX_FILES = 20;

/** Env var set to `1` by an agent that announced the `files` capability. Read once, removed. */
export const TOOLS_FILES_ENV = "KOBE_TOOLS_FILES";
export const TOOL_SHARE_FILE = "share_file";
/** Mirrors packages/protocol `files.ts` (pinned by a test). */
export const SHARE_PATH_MAX = 1024;
export const SHARE_DESCRIPTION_MAX = 500;
export const SHARE_NAME_MAX = 255;

/**
 * Env var set to `1` by an agent that announced the `projects` capability (KOBE-162). Read once,
 * removed. `commit_project` is registered only then; the server also checks the capability.
 */
export const TOOLS_PROJECTS_ENV = "KOBE_TOOLS_PROJECTS";
/**
 * KOBE-580 (CM6): registered with the `projects` capability, active only in runs whose
 * `run.start.project.access` is `write` (the agent says so in the run's memory file).
 */
export const TOOL_COMMIT_PROJECT = "commit_project";
/** Mirrors packages/protocol `project-commits.ts` PROJECT_COMMIT_MESSAGE_MAX (pinned by a test). */
export const PROJECT_COMMIT_MESSAGE_MAX = 500;
/** The agent pushes the whole working copy before the server commits: allow for large files. */
export const PROJECT_COMMIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Env var set to `1` by an agent that announced the `skill_drafts` capability (KOBE-442). Read
 * once, removed. `save_skill_draft` is registered only then; the server also checks the capability.
 */
export const TOOLS_SKILL_DRAFTS_ENV = "KOBE_TOOLS_SKILL_DRAFTS";
export const TOOL_SAVE_SKILL_DRAFT = "save_skill_draft";
/** Mirrors packages/protocol `skill-package/layout.ts` SKILL_NAME_PATTERN (pinned by a test). */
export const SKILL_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Env var set to `1` by an agent that announced the `file_edits` capability (KOBE-462). Read once,
 * removed. `propose_file_edit` is registered only then; the server also checks the capability.
 */
export const TOOLS_FILE_EDITS_ENV = "KOBE_TOOLS_FILE_EDITS";
export const TOOL_PROPOSE_FILE_EDIT = "propose_file_edit";
/** KOBE-484: registered with `propose_file_edit` (same capability and env var). */
export const TOOL_OPEN_FILE = "open_file";
/** Mirror packages/protocol `file-editor.ts` (pinned by a test). */
export const FILE_EDIT_CONTENT_MAX_BYTES = 128 * 1024;
export const FILE_EDIT_SUMMARY_MAX = 500;

/**
 * Env var set to `1` by an agent that announced the `notebooks` capability (KOBE-464). Read once,
 * removed. `run_python` is registered only then; the server also checks the capability.
 */
export const TOOLS_NOTEBOOKS_ENV = "KOBE_TOOLS_NOTEBOOKS";
export const TOOL_RUN_PYTHON = "run_python";
/** Mirror packages/protocol `notebooks.ts` (pinned by a test). */
export const NOTEBOOK_CODE_MAX_BYTES = 256 * 1024;
export const NOTEBOOK_TIMEOUT_DEFAULT_S = 600;
export const NOTEBOOK_TIMEOUT_MAX_S = 3600;
/** How long past the cell's own timeout the tool waits for the server (delivery, saving). */
export const NOTEBOOK_ANSWER_MARGIN_MS = 120_000;

export const TOOL_CREATE_ARTIFACT = "create_artifact";
export const TOOL_UPDATE_ARTIFACT = "update_artifact";

/** `artifact.put` and `policy.check` frames: the server closes the connection above 1 MiB. */
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_CONTENT_BYTES = 512 * 1024;
export const MAX_TITLE_LENGTH = 200;
/** One reply line from the agent; anything longer closes the channel (fail closed). */
export const MAX_REPLY_LINE_BYTES = 64 * 1024;
/** Requests in flight per Pi process. */
export const MAX_PENDING_REQUESTS = 16;
export const MAX_ID_LENGTH = 128;

export interface ToolsRequest {
  readonly id: string;
  readonly op: (typeof OPS)[number];
  readonly tool_call_id: string;
  /** Absent on the memory ops, whose frames carry no tool name (memory.ts). */
  readonly tool?: string;
  readonly input: Record<string, unknown>;
}

export interface ToolsError {
  readonly code: string;
  readonly message: string;
}

export interface SharedFileFields {
  readonly file_id: string;
  readonly name: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly scan: string;
  readonly created_at: string;
  readonly sha256: string;
}

/** `commit_project` answer (CM6): what the server did with the commit. */
export type ProjectCommitOutcome =
  | { readonly status: "committed"; readonly seq: number }
  | { readonly status: "commit_conflict"; readonly head_seq: number }
  | { readonly status: "nothing_to_commit" }
  | { readonly status: "pending_approval" };
export interface ProjectCommitAnswer {
  readonly ok: true;
  readonly op: "project_commit";
  readonly outcome: ProjectCommitOutcome;
}

/** `save_skill_draft` answer: the member's private Workbench draft, made or updated. */
export interface SkillDraftAnswer {
  readonly ok: true;
  readonly op: "skill_draft_save";
  readonly draft_id: string;
  readonly name: string;
  readonly created: boolean;
  readonly rev: number;
  readonly file_count: number;
  /** A new draft although the conversation had one: it was shared, or edited since. */
  readonly new_because?: "shared" | "edited";
}

/** `propose_file_edit` answer: nothing was written; the member reviews and commits it. */
export interface FileEditAnswer {
  readonly ok: true;
  readonly op: "file_edit_propose";
  readonly status: "awaiting_user";
  readonly path: string;
  /** Absent for a proposed new file (KOBE-591). */
  readonly base_sha256?: string;
}

/** `open_file` answer (KOBE-484): the user's client opens `path`. */
export interface FileOpenAnswer {
  readonly ok: true;
  readonly op: "file_open";
  readonly path: string;
}

/** `run_python` answer: how the execution ended, its outputs as text for the model. */
export interface NotebookRunAnswer {
  readonly ok: true;
  readonly op: "notebook_run";
  readonly status: string;
  readonly execution_count: number | null;
  readonly text: string;
  readonly truncated: boolean;
  readonly saved: { readonly path: string; readonly sha256: string } | null;
}

export interface MemoryPutAnswer {
  readonly ok: true;
  readonly op: "put";
  readonly status: "applied" | "pending_approval";
  readonly scope: string;
  readonly path: string;
  readonly version?: number;
  readonly previous_version?: number;
}
export interface MemoryReadAnswer {
  readonly ok: true;
  readonly op: "read";
  readonly files: readonly {
    readonly scope: string;
    readonly path: string;
    readonly content?: string;
    readonly version: number;
  }[];
  readonly truncated: boolean;
}

export type ToolsResponse =
  | ({ readonly id: string } & MemoryPutAnswer)
  | ({ readonly id: string } & MemoryReadAnswer)
  | ({ readonly id: string } & ProjectCommitAnswer)
  | ({ readonly id: string } & SkillDraftAnswer)
  | ({ readonly id: string } & FileEditAnswer)
  | ({ readonly id: string } & FileOpenAnswer)
  | ({ readonly id: string } & NotebookRunAnswer)
  | {
      readonly id: string;
      readonly ok: true;
      readonly artifact_id: string;
      readonly version: number;
    }
  | ({ readonly id: string; readonly ok: true } & SharedFileFields)
  | { readonly id: string; readonly ok: false; readonly error: ToolsError };
