import { randomUUID } from "node:crypto";

/**
 * Object keys (KOBE-27). Every key is derived here from ids the server verified (the sandbox
 * token's team and user) and a content hash — never from a path or name a sandbox or user chose —
 * so one workspace's keys can't name another's. Layout under the configured prefix:
 *
 *   teams/<team_id>/users/<user_id>/workspace/<sha256>   content-addressed workspace blobs
 *   teams/<team_id>/users/<user_id>/shared/<uuid>         durable shared copies (share_file)
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface WorkspaceOwner {
  readonly teamId: string;
  readonly userId: string;
}

function check(owner: WorkspaceOwner): void {
  if (!UUID.test(owner.teamId) || !UUID.test(owner.userId)) {
    throw new Error("workspace keys: team and user must be lowercase UUIDs");
  }
}

export function workspacePrefix(prefix: string, owner: WorkspaceOwner): string {
  check(owner);
  return `${prefix}teams/${owner.teamId}/users/${owner.userId}/workspace/`;
}

export function workspaceBlobKey(prefix: string, owner: WorkspaceOwner, sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error("workspace keys: not a SHA-256");
  return `${workspacePrefix(prefix, owner)}${sha256}`;
}

export function sharedKey(
  prefix: string,
  owner: WorkspaceOwner,
  id: string = randomUUID(),
): { readonly id: string; readonly key: string } {
  check(owner);
  if (!UUID.test(id)) throw new Error("workspace keys: shared id must be a UUID");
  return { id, key: `${prefix}teams/${owner.teamId}/users/${owner.userId}/shared/${id}` };
}
