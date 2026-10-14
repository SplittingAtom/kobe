import {
  THREAD_COMPACT_SUMMARY_MAX_BYTES,
  utf8ByteLength,
  type ThreadCompactFrame,
  type ThreadCompactResultFrame,
} from "@kobe/protocol";
import { gatewayBaseUrl } from "../kobe-models/protocol.js";
import { PiProcessError } from "../pi/pi-process.js";
import type { RunModel } from "../models/types.js";

/** The Pi provider id kobe-models registers (kobe-models/protocol.ts `KOBE_PROVIDER_ID`). */
const KOBE_PROVIDER = "kobe";

type ResultOk = Extract<ThreadCompactResultFrame, { ok: true }>;
type ResultErr = Extract<ThreadCompactResultFrame, { ok: false }>;

/** What `thread.compact` answers, before the agent adds `command_id` and `thread_id`. */
export type CompactReply =
  | Omit<ResultOk, "v" | "type" | "command_id" | "thread_id">
  | Omit<ResultErr, "v" | "type" | "command_id" | "thread_id">;

export type CompactErrorCode = ResultErr["error"]["code"];

export const compactFailure = (code: CompactErrorCode, message: string): CompactReply => ({
  ok: false,
  error: { code, message: message.slice(0, 2000) },
});

/** The compaction run's model (`thread.compact.model`, required there) and its limits. */
export function compactModelOf(frame: ThreadCompactFrame): RunModel {
  const limits = frame.model_limits;
  return {
    gatewayModel: frame.model.gateway_model,
    api: frame.model.api,
    ...(limits === undefined
      ? {}
      : {
          limits: {
            maxOutputTokens: limits.max_output_tokens,
            contextWindow: limits.context_window,
          },
        }),
  };
}

/**
 * Pi already uses `model` (`get_state.model`): the kobe model of that gateway model, served by the
 * model gateway (`baseUrl`: a kobe model a tool planted elsewhere is never accepted, KOBE-169)
 * and, when the server sent limits, with exactly those limits. Pi reads the model before
 * `session_before_compact`, so the summary goes to whatever is selected here.
 */
export function selectsModel(state: unknown, model: RunModel, gatewayUrl: string): boolean {
  if (state === null || typeof state !== "object") return false;
  const selected = (state as { model?: unknown }).model;
  if (selected === null || typeof selected !== "object") return false;
  const m = selected as {
    provider?: unknown;
    id?: unknown;
    baseUrl?: unknown;
    contextWindow?: unknown;
    maxTokens?: unknown;
  };
  if (m.provider !== KOBE_PROVIDER || m.id !== model.gatewayModel) return false;
  if (m.baseUrl !== gatewayBaseUrl(gatewayUrl, model.api)) return false;
  const limits = model.limits;
  return (
    limits === undefined ||
    (m.contextWindow === limits.contextWindow && m.maxTokens === limits.maxOutputTokens)
  );
}

/** Pi RPC `set_model` for the compaction's model (only the kobe provider; never the server's input). */
export const setModelCommand = (model: RunModel) => ({
  type: "set_model",
  provider: KOBE_PROVIDER,
  modelId: model.gatewayModel,
});

/** Pi's `compact` command with the member's focus verbatim as `customInstructions`. */
export const compactCommand = (frame: ThreadCompactFrame) => ({
  type: "compact",
  ...(frame.focus === undefined ? {} : { customInstructions: frame.focus }),
});

/**
 * Pi's `success:false` text mapped to a wire code (KOBE-212 ledger, verified Pi 1.0.0): "Nothing to
 * compact (session too small)" and "Already compacted" are `nothing_to_compact`; "No model
 * selected" is `model_not_configured`; anything else (a cancelled or failed summary) is
 * `compaction_failed`. The text goes along for the server's log only.
 */
export function piCompactFailure(error: string): CompactReply {
  if (/^Nothing to compact\b|^Already compacted\b/.test(error)) {
    return compactFailure("nothing_to_compact", error);
  }
  if (/^No model selected\b/.test(error)) return compactFailure("model_not_configured", error);
  return compactFailure("compaction_failed", error);
}

/**
 * Pi's `CompactionResult` in the wire's casing. A summary over the cap is left out (the mirrored
 * entry is authoritative); a result without a usable first kept entry or token count is refused.
 */
export function compactSuccess(data: unknown): CompactReply {
  if (data === null || typeof data !== "object") {
    return compactFailure("internal", "Pi answered compact without a result");
  }
  const r = data as {
    summary?: unknown;
    firstKeptEntryId?: unknown;
    tokensBefore?: unknown;
    estimatedTokensAfter?: unknown;
  };
  const count = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
  if (typeof r.firstKeptEntryId !== "string" || !count(r.tokensBefore)) {
    return compactFailure("internal", "Pi's compact result is malformed");
  }
  const summary =
    typeof r.summary === "string" &&
    r.summary.length > 0 &&
    utf8ByteLength(r.summary) <= THREAD_COMPACT_SUMMARY_MAX_BYTES
      ? r.summary
      : undefined;
  return {
    ok: true,
    ...(summary === undefined ? {} : { summary }),
    first_kept_entry_id: r.firstKeptEntryId,
    tokens_before: r.tokensBefore,
    ...(count(r.estimatedTokensAfter) ? { estimated_tokens_after: r.estimatedTokensAfter } : {}),
  };
}

/** A thrown error while compacting (Pi gone, timed out) as a wire failure. */
export function compactThrown(error: unknown): CompactReply {
  if (error instanceof PiProcessError) return compactFailure("pi_unavailable", error.message);
  return compactFailure("internal", "unexpected error talking to Pi");
}
