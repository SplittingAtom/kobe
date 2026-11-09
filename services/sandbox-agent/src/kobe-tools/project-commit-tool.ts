import { frameSizeProblem } from "./frame-size.js";
import {
  OP_PROJECT_COMMIT,
  PROJECT_COMMIT_MESSAGE_MAX,
  PROJECT_COMMIT_TIMEOUT_MS,
  TOOL_COMMIT_PROJECT,
  type ProjectCommitOutcome,
} from "./protocol.js";
import {
  ToolFailure,
  type ToolDefinitionLike,
  type ToolResultLike,
  type ToolsTransport,
} from "./tools.js";

const COMMIT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: {
      type: "string",
      minLength: 1,
      maxLength: PROJECT_COMMIT_MESSAGE_MAX,
      description: "The commit message: one line saying what changed and why.",
    },
  },
};

/**
 * `commit_project` (KOBE-580, spec CM6): commits the member's checked-out working copy of the
 * conversation's project (`/workspace/projects/<slug>`). Registered with the `projects`
 * capability and listed to the model only in runs whose viewer may edit the project
 * (`run.start.project.access: "write"`, memory-hooks.ts). kobe-policy decides first (a project
 * write: a policy rule or a signed approval); the agent then pushes the working copy and sends
 * `project.commit`; the server diffs it against the checkout's base and answers. The model
 * names only the message: the project, the files and the base are never its choice.
 */
export function commitProjectTool(transport: ToolsTransport): ToolDefinitionLike {
  return {
    name: TOOL_COMMIT_PROJECT,
    label: "Commit project",
    description:
      "Commit your changes to the conversation's project: every file you changed under /workspace/projects/<project> (the user's checked-out working copy) becomes the project's next version, with this message. A person may have to approve it first.",
    promptSnippet: "Commit the checked-out project working copy with a message",
    promptGuidelines: [
      "Use commit_project once the project's files are in a good state and the user wants the change kept; edit files under /workspace/projects/<project> first, then commit with a one-line message.",
    ],
    parameters: COMMIT_PARAMETERS,
    execute: (toolCallId, params) => commit(transport, toolCallId, params),
  };
}

/** What the model reads for each outcome. */
export function commitOutcomeText(outcome: ProjectCommitOutcome): string {
  switch (outcome.status) {
    case "committed":
      return `Committed as #${outcome.seq}.`;
    case "commit_conflict":
      return `Not committed: the project has moved on to #${outcome.head_seq} since this working copy was checked out. Ask the user to Update the checkout (it brings in the newer version and keeps both sides of any file changed on both), then commit again.`;
    case "nothing_to_commit":
      return "Nothing to commit: the working copy matches the project's latest version.";
    case "pending_approval":
      return "Awaiting approval: the commit is made as soon as a person approves it. Do not commit again meanwhile.";
  }
}

async function commit(
  transport: ToolsTransport,
  toolCallId: string,
  params: unknown,
): Promise<ToolResultLike> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new ToolFailure("invalid input");
  }
  const input = params as Record<string, unknown>;
  const { message } = input;
  if (
    Object.keys(input).some((key) => key !== "message") ||
    typeof message !== "string" ||
    message.trim() === "" ||
    message.length > PROJECT_COMMIT_MESSAGE_MAX
  ) {
    throw new ToolFailure(
      `invalid input: expected { message } (1 to ${PROJECT_COMMIT_MESSAGE_MAX} characters)`,
    );
  }
  const problem = frameSizeProblem(toolCallId, TOOL_COMMIT_PROJECT, input);
  if (problem !== undefined) throw new ToolFailure(problem);
  const outcome = await transport.request(
    {
      op: OP_PROJECT_COMMIT,
      tool_call_id: toolCallId,
      tool: TOOL_COMMIT_PROJECT,
      input: { message },
    },
    { timeoutMs: PROJECT_COMMIT_TIMEOUT_MS },
  );
  if (!outcome.ok) throw new ToolFailure(`${outcome.error.code}: ${outcome.error.message}`);
  if (!("op" in outcome) || outcome.op !== "project_commit") {
    throw new ToolFailure("unexpected answer to commit_project");
  }
  return {
    content: [{ type: "text", text: commitOutcomeText(outcome.outcome) }],
    details: { ...outcome.outcome },
  };
}
