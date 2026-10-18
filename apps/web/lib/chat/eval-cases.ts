import type { FeedbackReason } from "./feedback";

/**
 * Sharing an answer as an eval case (KOBE-276), camelized from `@kobe/protocol` eval-cases.ts. The
 * conversation's owner previews exactly what the agent's owner would get, adds earlier turns, tool
 * outputs or file names only by ticking them, and shares with the preview's digest. The agent's
 * owner never sees who shared it; withdrawing deletes the copy.
 */

export interface EvalCaseOptions {
  readonly earlierExchanges: number;
  readonly toolOutputIds: readonly string[];
  readonly attachmentIds: readonly string[];
}

export const NO_EXTRAS: EvalCaseOptions = {
  earlierExchanges: 0,
  toolOutputIds: [],
  attachmentIds: [],
};

export interface EvalCaseContent {
  readonly prompt: string;
  readonly answer: string;
  readonly earlier: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  readonly toolOutputs: readonly {
    readonly tool: string;
    readonly text: string;
    readonly isError: boolean;
  }[];
  readonly attachments: readonly {
    readonly name: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  }[];
  readonly reasons: readonly FeedbackReason[];
  readonly comment: string | null;
  readonly truncated: boolean;
}

/** `POST /v1/runs/{id}/eval-case/preview`. */
export interface EvalCasePreview {
  readonly runId: string;
  readonly agent: {
    readonly scope: "team" | "personal";
    readonly id: string;
    readonly version: number | null;
  };
  readonly content: EvalCaseContent;
  readonly digest: string;
  readonly available: {
    readonly earlierExchanges: number;
    readonly toolOutputs: readonly {
      readonly id: string;
      readonly tool: string;
      readonly isError: boolean;
    }[];
    readonly attachments: readonly {
      readonly id: string;
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
    }[];
  };
  readonly sharedCaseId: string | null;
}

/** The member's own shared case (`POST /v1/runs/{id}/eval-case`). */
export interface MyEvalCase {
  readonly id: string;
  readonly status: "open" | "accepted" | "dismissed";
  readonly content: EvalCaseContent;
  readonly sharedAt: string;
}

/** The wire body (snake_case). */
export function evalCaseOptionsBody(options: EvalCaseOptions): Record<string, unknown> {
  return {
    earlier_exchanges: options.earlierExchanges,
    tool_output_ids: [...options.toolOutputIds],
    attachment_ids: [...options.attachmentIds],
  };
}
