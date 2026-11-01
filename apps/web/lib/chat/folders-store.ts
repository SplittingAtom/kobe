/**
 * The team's folders for this tab (KOBE-536, TF7): one read shared by the Threads panel's tree,
 * the row menus' Save to folder and the conversation's commands. Read again when the panel opens,
 * when the window regains focus and after every folder change the member makes here (no push:
 * another member's new folder shows on the next of those).
 */
import type { ApiError, ApiResult } from "../api/client";
import type { FolderChange, FolderView, FoldersApi } from "./folders-api";

export type FoldersState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly folders: readonly FolderView[] }
  | { readonly status: "ready"; readonly folders: readonly FolderView[] }
  | {
      readonly status: "error";
      readonly folders: readonly FolderView[];
      readonly error: ApiError;
    };

const NONE: readonly FolderView[] = [];

export const foldersOf = (state: FoldersState): readonly FolderView[] =>
  state.status === "idle" ? NONE : state.folders;

export class ThreadFoldersStore {
  readonly #api: FoldersApi;
  readonly #listeners = new Set<() => void>();
  #state: FoldersState = { status: "idle" };
  #reading: Promise<void> | undefined;
  #again = false;

  constructor(api: FoldersApi) {
    this.#api = api;
  }

  get api(): FoldersApi {
    return this.#api;
  }

  readonly getState = (): FoldersState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(state: FoldersState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  /** Reads the folders; a read asked for while one runs follows it once. */
  refresh(): Promise<void> {
    if (this.#reading) {
      this.#again = true;
      return this.#reading;
    }
    this.#set({ status: "loading", folders: foldersOf(this.#state) });
    const reading = this.#api.list().then((res) => {
      if (res.ok) this.#set({ status: "ready", folders: res.data });
      else {
        console.warn("threads: could not read the folders", res.error);
        this.#set({ status: "error", folders: foldersOf(this.#state), error: res.error });
      }
    });
    this.#reading = reading.finally(() => {
      this.#reading = undefined;
      if (this.#again) {
        this.#again = false;
        void this.refresh();
      }
    });
    return this.#reading;
  }

  /** Reads them unless a read is done or running (a menu opening). */
  ensure(): void {
    if (this.#state.status === "idle" || this.#state.status === "error") void this.refresh();
  }

  async #changed<T>(call: Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    const res = await call;
    if (res.ok) await this.refresh();
    return res;
  }

  create(name: string, parentId: string | null): Promise<ApiResult<FolderView>> {
    return this.#changed(this.#api.create(name, parentId));
  }

  update(id: string, change: FolderChange): Promise<ApiResult<FolderView>> {
    return this.#changed(this.#api.update(id, change));
  }

  remove(id: string): Promise<ApiResult<void>> {
    return this.#changed(this.#api.remove(id));
  }
}
