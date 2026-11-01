/**
 * The team's thread folders for `FakeKobe` (KOBE-536): `/v1/thread-folders` as the server rules
 * it (KOBE-534, TF1/TF4): unique names among siblings ignoring case, three levels, no cycles,
 * subfolders deleted with their parent and their threads back in `Current`. Wire casing.
 */

export interface FakeFolder {
  id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_by: string;
}

/** What the folders need of a thread: its folder, and whether it counts (live, unarchived). */
export interface FolderedThread {
  folder_id?: string | null;
  deleted_at: string | null;
  archived_at?: string | null;
  is_test?: boolean;
}

const MAX_DEPTH = 3;

function folderId(n: number): string {
  return `00000000-0000-4000-8000-0011${String(n).padStart(8, "0")}`;
}

function answer(status: number, body?: unknown): Response {
  return body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
}

const refuse = (status: number, code: string, message = code) => answer(status, { code, message });

export class FakeFolders {
  readonly folders = new Map<string, FakeFolder>();
  #n = 0;
  readonly threads: () => Iterable<FolderedThread>;
  readonly userId: string;

  constructor(threads: () => Iterable<FolderedThread>, userId: string) {
    this.threads = threads;
    this.userId = userId;
  }

  /** Adds a folder as any member would (another member's, for a test of the focus read). */
  add(name: string, parentId: string | null = null): string {
    this.#n += 1;
    const id = folderId(this.#n);
    this.folders.set(id, { id, parent_id: parentId, name, position: 0, created_by: this.userId });
    return id;
  }

  has(id: string): boolean {
    return this.folders.has(id);
  }

  #depth(id: string | null): number {
    let depth = 0;
    for (let at = id; at !== null && depth < 32; depth += 1) {
      at = this.folders.get(at)?.parent_id ?? null;
    }
    return depth;
  }

  #subtree(id: string): string[] {
    const out = [id];
    for (let i = 0; i < out.length; i += 1) {
      for (const f of this.folders.values()) if (f.parent_id === out[i]) out.push(f.id);
    }
    return out;
  }

  #height(id: string): number {
    const below = [...this.folders.values()].filter((f) => f.parent_id === id);
    return below.length === 0 ? 0 : 1 + Math.max(...below.map((f) => this.#height(f.id)));
  }

  #taken(parentId: string | null, name: string, except?: string): boolean {
    return [...this.folders.values()].some(
      (f) =>
        f.id !== except && f.parent_id === parentId && f.name.toLowerCase() === name.toLowerCase(),
    );
  }

  #view(f: FakeFolder): Record<string, unknown> {
    let threads = 0;
    for (const t of this.threads()) {
      if (t.folder_id === f.id && t.deleted_at === null && !t.archived_at && !t.is_test) {
        threads += 1;
      }
    }
    return { ...f, threads };
  }

  /** `/v1/thread-folders[/{id}]`. */
  route(method: string, id: string | undefined, body: Record<string, unknown> | undefined) {
    if (id === undefined && method === "GET") {
      return answer(200, { folders: [...this.folders.values()].map((f) => this.#view(f)) });
    }
    if (id === undefined && method === "POST") {
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      const parentId = typeof body?.parent_id === "string" ? body.parent_id : null;
      if (name === "") return refuse(400, "invalid_request");
      if (parentId !== null && !this.folders.has(parentId)) {
        return refuse(404, "folder_not_found", "No folder with that id in this team.");
      }
      if (this.#depth(parentId) + 1 > MAX_DEPTH) {
        return refuse(409, "folder_too_deep", "Folders go three levels deep.");
      }
      if (this.#taken(parentId, name)) {
        return refuse(
          409,
          "folder_name_taken",
          "A folder with that name is already there. Choose another name.",
        );
      }
      const created = this.add(name, parentId);
      return answer(201, this.#view(this.folders.get(created) as FakeFolder));
    }
    const folder = id === undefined ? undefined : this.folders.get(id);
    if (!folder) return refuse(404, "folder_not_found", "No folder with that id in this team.");
    if (method === "PATCH") return this.#update(folder, body ?? {});
    if (method === "DELETE") {
      const gone = new Set(this.#subtree(folder.id));
      for (const f of gone) this.folders.delete(f);
      for (const t of this.threads()) if (t.folder_id && gone.has(t.folder_id)) t.folder_id = null;
      return answer(204);
    }
    return refuse(405, "method_not_allowed");
  }

  #update(folder: FakeFolder, body: Record<string, unknown>): Response {
    const name = typeof body.name === "string" ? body.name.trim() : folder.name;
    const parentId =
      body.parent_id === undefined ? folder.parent_id : (body.parent_id as string | null);
    if (parentId !== null) {
      if (!this.folders.has(parentId)) return refuse(404, "folder_not_found");
      if (this.#subtree(folder.id).includes(parentId)) {
        return refuse(409, "folder_cycle", "A folder can't be moved inside itself.");
      }
    }
    if (this.#depth(parentId) + 1 + this.#height(folder.id) > MAX_DEPTH) {
      return refuse(409, "folder_too_deep", "Folders go three levels deep.");
    }
    if (this.#taken(parentId, name, folder.id)) {
      return refuse(
        409,
        "folder_name_taken",
        "A folder with that name is already there. Choose another name.",
      );
    }
    Object.assign(folder, { name, parent_id: parentId });
    return answer(200, this.#view(folder));
  }
}
