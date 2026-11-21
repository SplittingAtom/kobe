import {
  CAPABILITY_ARTIFACTS,
  CAPABILITY_FILES,
  type ArtifactPutFrame,
  type FileShareFrame,
} from "@kobe/protocol";
import { putArtifact } from "../../artifacts/put.js";
import { shareFile } from "../../files/share.js";
import type { WireContext } from "../context.js";
import type { InFlight, ToolFrameSpec } from "../gated-frame.js";
import type { ConnectionPort } from "./port.js";

type ArtifactRefusal = Parameters<WireContext["auditArtifactRefused"]>[2]["reason"];
type FileShareRefusal = Parameters<WireContext["auditFileShareRefused"]>[2]["reason"];

/**
 * `artifact.put` (KOBE-129, D-3 of KOBE-55). Past the gate (the `artifacts` capability, the run
 * leased here and active, this tool call allowed here for this tool with the same canonical input
 * hash), the rest (same team and thread, idempotency) is in `putArtifact`. Every refusal is
 * audited (no content) and answered with `artifact.result`.
 */
export function artifactPutSpec(
  port: ConnectionPort,
  inFlight: InFlight,
): ToolFrameSpec<ArtifactPutFrame, "check"> {
  const { ctx } = port;
  const audit = (frame: ArtifactPutFrame, reason: ArtifactRefusal) =>
    ctx.auditArtifactRefused(port.target, port.sandboxId, {
      reason,
      tool: frame.tool,
      runId: frame.run_id,
      toolCallId: frame.tool_call_id,
    });
  const fail = (frame: ArtifactPutFrame, code: string, message: string) =>
    port.send({
      v: 1,
      type: "artifact.result",
      request_id: frame.request_id,
      ok: false,
      error: { code, message },
    });
  const refuse = (
    frame: ArtifactPutFrame,
    reason: ArtifactRefusal,
    code: "not_allowed" | "not_found",
    message: string,
  ) => {
    audit(frame, reason);
    fail(frame, code, message);
  };
  return {
    capabilities: [CAPABILITY_ARTIFACTS],
    allowance: "check",
    inFlight,
    refuse(frame, refusal) {
      switch (refusal.stage) {
        case "capability":
          refuse(
            frame,
            "capability_missing",
            "not_allowed",
            "This sandbox did not announce artifact support.",
          );
          return;
        case "ended":
          refuse(
            frame,
            "run_not_active",
            "not_allowed",
            "The run has ended, so the artifact was not stored.",
          );
          return;
        case "verdict":
          refuse(
            frame,
            refusal.verdict,
            "not_allowed",
            refusal.verdict === "input_mismatch"
              ? "The artifact differs from the call that was allowed."
              : "This tool call was not allowed for this tool.",
          );
          return;
        case "busy":
          fail(frame, "storage_failed", "Too many artifacts are being stored. Try again.");
          return;
      }
    },
    act: (frame) =>
      putArtifact(ctx.artifacts, port.target, frame)
        .catch((err: unknown) => {
          port.log.error({ err }, "artifact.put failed");
          return {
            ok: false,
            code: "storage_failed",
            message: "The artifact could not be stored. Try again.",
          } as const;
        })
        .then((result) => {
          if (result.ok) {
            port.send({
              v: 1,
              type: "artifact.result",
              request_id: frame.request_id,
              ok: true,
              artifact_id: result.artifactId,
              version: result.version,
            });
            return;
          }
          if ("refusal" in result && result.refusal) audit(frame, result.refusal);
          fail(frame, result.code, result.message);
        }),
  };
}

/**
 * `file.share` (KOBE-150). Past the gate (`files`, the run leased here and active, this
 * `share_file` call allowed here with the same canonical input hash, D-3), the manifest check,
 * copy, quota, row and event are in `shareFile`. Every refusal is audited (no names or content)
 * and answered with `file.share_result`.
 */
export function fileShareSpec(
  port: ConnectionPort,
  inFlight: InFlight,
): ToolFrameSpec<FileShareFrame, "check"> {
  const { ctx } = port;
  const audit = (frame: FileShareFrame, reason: FileShareRefusal) =>
    ctx.auditFileShareRefused(port.target, port.sandboxId, {
      reason,
      runId: frame.run_id,
      toolCallId: frame.tool_call_id,
    });
  const fail = (frame: FileShareFrame, code: string, message: string) =>
    port.send({
      v: 1,
      type: "file.share_result",
      request_id: frame.request_id,
      ok: false,
      error: { code, message },
    });
  const refuse = (frame: FileShareFrame, reason: FileShareRefusal, message: string) => {
    audit(frame, reason);
    fail(frame, "not_allowed", message);
  };
  return {
    capabilities: [CAPABILITY_FILES],
    allowance: "check",
    inFlight,
    refuse(frame, refusal) {
      switch (refusal.stage) {
        case "capability":
          refuse(frame, "capability_missing", "This sandbox did not announce file sharing.");
          return;
        case "ended":
          refuse(frame, "run_not_active", "The run has ended, so the file was not shared.");
          return;
        case "verdict":
          refuse(
            frame,
            refusal.verdict,
            refusal.verdict === "input_mismatch"
              ? "The file differs from the call that was allowed."
              : "This tool call was not allowed for this tool.",
          );
          return;
        case "busy":
          fail(frame, "storage_failed", "Too many files are being shared. Try again.");
          return;
      }
    },
    act: (frame) =>
      shareFile(ctx.fileShare, port.target, frame)
        .catch((err: unknown) => {
          port.log.error({ err }, "file.share failed");
          return {
            ok: false,
            code: "storage_failed",
            message: "The file could not be shared. Try again.",
          } as const;
        })
        .then((result) => {
          if (result.ok) {
            port.send({
              v: 1,
              type: "file.share_result",
              request_id: frame.request_id,
              ok: true,
              ...result.file,
            });
            return;
          }
          if ("refusal" in result && result.refusal) audit(frame, result.refusal);
          fail(frame, result.code, result.message);
        }),
  };
}
