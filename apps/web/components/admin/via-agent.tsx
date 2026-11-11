import Link from "next/link";
import type { ViaAgent } from "../../lib/admin/api/audit-via";

/**
 * "via agent" under the person who acted (spec kobe-admin-mcp §7): the thread is a link only for a
 * viewer the server says may read it; the run and tool call ids are always shown.
 */
export function ViaAgentNote({ via }: { readonly via: ViaAgent | undefined }) {
  if (via === undefined) return null;
  return (
    <div className="text-sm text-console-muted" data-kobe-via-agent="">
      via agent
      {via.threadOpen ? (
        <>
          {" "}
          (<Link href={`/?thread=${encodeURIComponent(via.threadId)}`}>open the thread</Link>)
        </>
      ) : null}
      <div className="break-all">
        run {via.runId}, tool call {via.toolCallId}
      </div>
    </div>
  );
}
