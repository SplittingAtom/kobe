import {
  SEMANTIC_MEMORY_ERROR_HTTP_STATUS,
  type SemanticMemoryError,
  type SemanticMemoryErrorCode,
} from "@kobe/protocol";

type Details = Omit<SemanticMemoryError, "code" | "message">;

/**
 * A refusal of the item store (KOBE-378): one of the contract's codes (errors.ts in
 * @kobe/protocol) with its HTTP status, or `invalid_request` (400) for a body that breaks a rule
 * of the stored item. Thrown inside the team transaction, so nothing of the refused write stays.
 */
export class MemoryItemError extends Error {
  readonly status: number;
  constructor(
    readonly code: SemanticMemoryErrorCode | "invalid_request",
    message: string,
    readonly details: Details = {},
  ) {
    super(message);
    this.name = "MemoryItemError";
    this.status = code === "invalid_request" ? 400 : SEMANTIC_MEMORY_ERROR_HTTP_STATUS[code];
  }

  body(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export const notFound = () =>
  new MemoryItemError("memory_item_not_found", "No such memory in a scope you can read.");
export const notAllowed = (message = "You can read this memory but not change it.") =>
  new MemoryItemError("memory_not_allowed", message);
export const disabled = () =>
  new MemoryItemError("memory_disabled", "Memory is turned off for this scope.");
export const invalid = (message: string) => new MemoryItemError("invalid_request", message);
export const inactive = (message = "Archived or superseded: restore it first.") =>
  new MemoryItemError("memory_item_inactive", message);
