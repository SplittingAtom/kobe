"use client";

import Link from "next/link";
import { REMEMBER_SCOPE_LABELS } from "@kobe/protocol";
import type { ApiResult } from "../../lib/api/client";
import type { MemberRule } from "../../lib/admin/api/remember";
import { visible } from "../../lib/security/visible";
import {
  Badge,
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  eventTrigger,
  useConfirm,
} from "../ui/console";
import { MutationStatus } from "./error-notice";
import { DateTime, ResourceView } from "./parts";
import { useFocusAfterRemoval } from "./use-focus-after-removal";
import { useMutation, useResource } from "./use-resource";

/** The literal text a server-derived exact glob matches (it escapes only `*`, `?` and `\`). */
function literal(glob: string): string {
  return glob.replace(/\\([\\*?])/g, "$1");
}

function Scope({ rule }: { readonly rule: MemberRule }) {
  const label = REMEMBER_SCOPE_LABELS[rule.rememberScope];
  // A member's private thread is never named to an admin (D18): "a conversation".
  if (rule.rememberScope === "thread" && rule.masked) return <>{label}: a conversation</>;
  if (rule.rememberScope === "thread" && rule.threadId !== null) {
    return (
      <>
        {label}:{" "}
        <Link href={`/?thread=${encodeURIComponent(rule.threadId)}`}>
          {rule.threadTitle ? visible(rule.threadTitle) : "Untitled conversation"}
        </Link>
      </>
    );
  }
  return <>{label}</>;
}

function Pattern({ rule }: { readonly rule: MemberRule }) {
  if (rule.argPointers.length === 0) return <>Any input</>;
  if (rule.argPattern === null) {
    return (
      <>
        Exact values (private) of{" "}
        {rule.argPointers.map((p, i) => (
          <span key={p}>
            {i > 0 && ", "}
            <code>{visible(p)}</code>
          </span>
        ))}
      </>
    );
  }
  return (
    <>
      {Object.entries(rule.argPattern).map(([pointer, glob]) => (
        <div key={pointer}>
          <code>{visible(pointer)}</code> is exactly <code>{visible(literal(glob))}</code>
        </div>
      ))}
    </>
  );
}

/**
 * Remembered approvals (KOBE-289): tool, scope, pattern, expiry and last use, with Revoke. The
 * member's own (My area, Approvals) or, with `showMember`, every member's in the team (team
 * Policy page). The server lists only live rules under the team's RLS and enforces the revoke;
 * it takes effect at the next tool call.
 */
export function RememberedRules({
  caption,
  headingId,
  showMember = false,
  load,
  revoke,
  empty,
}: {
  readonly caption: string;
  /** The section heading focus returns to when the last row goes. */
  readonly headingId: string;
  readonly showMember?: boolean;
  readonly load: () => Promise<ApiResult<readonly MemberRule[]>>;
  readonly revoke: (id: string) => Promise<ApiResult<void>>;
  readonly empty: string;
}) {
  const { state, reload } = useResource(load);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const focus = useFocusAfterRemoval(
    state.status === "ready" ? state.data.map((r) => r.id) : null,
    headingId,
  );

  async function onRevoke(rule: MemberRule, index: number, trigger: HTMLElement | null) {
    const who = showMember ? ` of ${rule.userName}` : "";
    const verb = rule.applies ? "Revoke" : "Remove";
    const yes = await confirm(
      {
        title: `${verb} the remembered approval${who} for ${rule.toolGlob}?`,
        description: rule.applies
          ? "Kobe asks again the next time this tool needs approval."
          : "It no longer applies; this removes it from the list.",
        confirmLabel: verb,
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => revoke(rule.id),
      () =>
        `${rule.applies ? "Revoked" : "Removed"}: ${rule.toolGlob} (${REMEMBER_SCOPE_LABELS[rule.rememberScope]}).`,
    );
    if (done) {
      focus.removed(rule.id, index);
      reload();
    }
  }

  return (
    <>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="remembered approvals">
        {(rules) =>
          rules.length === 0 ? (
            <EmptyState title={empty} />
          ) : (
            <div ref={focus.container}>
              <Table caption={`${caption} (${rules.length})`}>
                <TableHead>
                  <TableRow>
                    {showMember && <TableHeader>Member</TableHeader>}
                    <TableHeader>Tool</TableHeader>
                    <TableHeader>Remembered for</TableHeader>
                    <TableHeader>Only this action</TableHeader>
                    <TableHeader>Expires</TableHeader>
                    <TableHeader>Last used</TableHeader>
                    <TableHeader>Status</TableHeader>
                    <TableHeader>
                      <span className="sr-only">Actions</span>
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rules.map((r, index) => (
                    <TableRow key={r.id}>
                      {showMember && <TableCell>{r.userName}</TableCell>}
                      <TableRowHeader>
                        <code>{r.toolGlob}</code>
                      </TableRowHeader>
                      <TableCell>
                        <Scope rule={r} />
                      </TableCell>
                      <TableCell className="break-words">
                        <Pattern rule={r} />
                      </TableCell>
                      <TableCell>
                        {r.expiresAt ? (
                          <DateTime value={r.expiresAt} compact />
                        ) : r.rememberScope === "thread" ? (
                          "With the conversation"
                        ) : r.rememberScope === "run" ? (
                          "With the run"
                        ) : (
                          "Never"
                        )}
                      </TableCell>
                      <TableCell>
                        {r.lastUsedAt ? <DateTime value={r.lastUsedAt} compact /> : "Not yet"}
                      </TableCell>
                      <TableCell>
                        {r.applies ? (
                          <Badge tone="running">Applies</Badge>
                        ) : (
                          <>
                            <Badge tone="neutral">No longer applies</Badge>
                            <div className="text-sm text-console-muted">{r.endedReason}</div>
                          </>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="danger"
                          data-remove=""
                          disabled={mutation.pending}
                          onClick={(e) => void onRevoke(r, index, eventTrigger(e))}
                        >
                          {r.applies ? "Revoke" : "Remove"}
                          <span className="sr-only">
                            {" "}
                            {showMember ? `${r.userName}'s ` : ""}rule for {r.toolGlob}
                          </span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        }
      </ResourceView>
      {confirmDialog}
    </>
  );
}
