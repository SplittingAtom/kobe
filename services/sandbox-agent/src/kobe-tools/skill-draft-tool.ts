import { frameSizeProblem } from "./frame-size.js";
import {
  OP_SKILL_DRAFT_SAVE,
  SKILL_NAME_RE,
  TOOL_SAVE_SKILL_DRAFT,
  type ToolsResponse,
} from "./protocol.js";
import {
  ToolFailure,
  type ToolDefinitionLike,
  type ToolResultLike,
  type ToolsTransport,
} from "./tools.js";

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["folder"],
  properties: {
    folder: {
      type: "string",
      pattern: SKILL_NAME_RE.source,
      description:
        "The skill's folder name under /workspace/skills/ (the skill's name, for example weekly-report), not a path.",
    },
  },
};

const NEW_BECAUSE =
  "The user's earlier draft from this conversation was shared or edited, so this is a new draft; say so.";
const NEXT =
  "Tell the user the draft is in their Workbench (the Open in Workbench card): there they can try it in the test pane, Run evals from evals/cases.yaml, and Save version when it is ready. Nothing is shared or published until they do.";

/**
 * `save_skill_draft` (KOBE-442): registered only for an agent that announced `skill_drafts`. The
 * agent pushes the folder and the server makes it the member's private Workbench draft (a second
 * save from the same conversation updates it). It never saves a version, submits for review or
 * runs evals: those stay the member's own steps in the Workbench.
 */
export function saveSkillDraftTool(transport: ToolsTransport): ToolDefinitionLike {
  return {
    name: TOOL_SAVE_SKILL_DRAFT,
    label: "Save skill draft",
    description:
      "Save the skill in /workspace/skills/<folder>/ as the user's private draft in their Kobe Workbench (saving again from this conversation updates the same draft). It checks the skill as an upload would and returns the draft. It does not publish, share or test the skill.",
    promptSnippet: "Save a finished skill folder to the user's Workbench as a private draft",
    promptGuidelines: [
      "Use save_skill_draft after the skill's validate.py passes; save again after later changes. The user then opens the draft in their Workbench to test it, run its evals and save a version.",
    ],
    parameters: PARAMETERS,
    execute: (toolCallId, params) => save(transport, toolCallId, params),
  };
}

async function save(
  transport: ToolsTransport,
  toolCallId: string,
  params: unknown,
): Promise<ToolResultLike> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new ToolFailure("invalid input");
  }
  const input = params as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => key !== "folder") ||
    typeof input.folder !== "string" ||
    !SKILL_NAME_RE.test(input.folder)
  ) {
    throw new ToolFailure("invalid input: expected { folder } (a skill name, not a path)");
  }
  const problem = frameSizeProblem(toolCallId, TOOL_SAVE_SKILL_DRAFT, input);
  if (problem !== undefined) throw new ToolFailure(problem);
  const outcome = await transport.request({
    op: OP_SKILL_DRAFT_SAVE,
    tool_call_id: toolCallId,
    tool: TOOL_SAVE_SKILL_DRAFT,
    input,
  });
  if (!outcome.ok) throw new ToolFailure(`${outcome.error.code}: ${outcome.error.message}`);
  if (!("op" in outcome) || outcome.op !== "skill_draft_save")
    throw new ToolFailure("unexpected answer to save_skill_draft");
  const { draft_id, name, created, rev, file_count, new_because } = outcome;
  const record = {
    draft_id,
    name,
    created,
    rev,
    file_count,
    ...(new_because ? { new_because } : {}),
  };
  const why = new_because ? `${NEW_BECAUSE} ` : "";
  return {
    content: [{ type: "text", text: JSON.stringify({ ...record, next: `${why}${NEXT}` }) }],
    details: { ...record },
  };
}

const isRecordId = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** A `save_skill_draft` answer, or undefined when it is malformed (fail closed). */
export function parseSkillDraftReply(value: Record<string, unknown>): ToolsResponse | undefined {
  const { draft_id: draft, name, created, rev, file_count: count } = value;
  if (!isRecordId(draft) || typeof name !== "string" || typeof created !== "boolean")
    return undefined;
  if (!Number.isSafeInteger(rev) || !Number.isSafeInteger(count)) return undefined;
  const because = value.new_because;
  if (because !== undefined && because !== "shared" && because !== "edited") return undefined;
  return {
    id: value.id as string,
    ok: true,
    op: "skill_draft_save",
    draft_id: draft,
    name,
    created,
    rev: rev as number,
    file_count: count as number,
    ...(because === undefined ? {} : { new_because: because }),
  };
}
