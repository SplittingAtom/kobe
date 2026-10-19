/**
 * The draft a `save_skill_draft` call made or updated (KOBE-442), read from the tool's result:
 * the JSON the kobe-tools extension returns (`draft_id`, `name`, `created`, ...). Undefined for
 * anything else (an error text, a malformed answer), so the card never links a guessed id.
 */
export interface SavedSkillDraft {
  readonly draftId: string;
  readonly name: string;
  readonly created: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function skillDraftFromToolResult(result: unknown): SavedSkillDraft | undefined {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== "object") return undefined;
  const { draft_id: id, name, created } = value as Record<string, unknown>;
  if (typeof id !== "string" || !UUID.test(id) || typeof name !== "string") return undefined;
  return { draftId: id, name, created: created !== false };
}

export const SAVE_SKILL_DRAFT_TOOL = "save_skill_draft";
