import { z } from "zod";
import { idSchema, uuidSchema } from "../common.js";
import {
  projectProposeFailFields,
  projectProposeOkFields,
  proposeProjectFileInputSchema,
  proposeProjectFileWorkspaceRefSchema,
} from "../projects.js";
import {
  commitProjectToolInputSchema,
  projectCommitFailFields,
  projectCommitOkFields,
} from "../project-commits.js";
import { SANDBOX_WIRE_VERSION } from "./connection.js";

/** Project frames (KOBE-159, projects.ts), behind hello capability `projects`. Same shape as `frame()` in frames.ts. */
function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v: z.literal(SANDBOX_WIRE_VERSION), type: z.literal(type), ...shape });
}

/**
 * Sandbox -> server: the `propose_project_file` call kobe-policy let through, sent AFTER the
 * agent pushed the file through workspace sync (push-then-propose). Answered by
 * `project.file_propose_result` for the same `request_id`. A small frame.
 */
export const projectFileProposeFrameSchema = frame("project.file_propose", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  tool: z.literal("propose_project_file"),
  input: proposeProjectFileInputSchema,
  workspace: proposeProjectFileWorkspaceRefSchema,
});

/** Server -> sandbox; `error.code` is open (known: `PROJECT_PROPOSE_ERROR_CODES`). */
export const projectFileProposeResultFrameSchema = z.union([
  frame("project.file_propose_result", { request_id: idSchema, ...projectProposeOkFields }),
  frame("project.file_propose_result", { request_id: idSchema, ...projectProposeFailFields }),
]);

/**
 * Sandbox -> server (KOBE-576, CM6): the `commit_project` call kobe-policy let through, sent AFTER
 * the agent pushed its working copy. Answered by `project.commit_result` for the same
 * `request_id`. Needs `run.start.project.access: "write"`; refused in auto and scheduled runs.
 */
export const projectCommitFrameSchema = frame("project.commit", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  tool: z.literal("commit_project"),
  input: commitProjectToolInputSchema,
});

/** Server -> sandbox. */
export const projectCommitResultFrameSchema = z.union([
  frame("project.commit_result", { request_id: idSchema, ...projectCommitOkFields }),
  frame("project.commit_result", { request_id: idSchema, ...projectCommitFailFields }),
]);
