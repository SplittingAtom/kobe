/**
 * What the Threads panel remembers while the tab lives (KOBE-536, TF7/TF12): the node last chosen
 * (Current on the first open), the tree's fold state and each node's groups opened or closed
 * against their default. In memory only: never stored, never sent.
 */
import { CURRENT, nodeKey, type PanelNode } from "./folder-tree";

export class ThreadsPanelMemory {
  #node: PanelNode = CURRENT;
  #currentOpen = false;
  #open: ReadonlySet<string> = new Set();
  #flipped: ReadonlySet<string> = new Set();
  readonly #listeners = new Set<() => void>();
  readonly #folderListeners = new Set<() => void>();
  #version = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Called when the chosen folder changes: the thread list reads that folder's lists. */
  onFolderChange(listener: () => void): () => void {
    this.#folderListeners.add(listener);
    return () => this.#folderListeners.delete(listener);
  }

  /** Changes on every update, for `useSyncExternalStore`. */
  readonly getVersion = (): number => this.#version;

  #changed(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }

  get node(): PanelNode {
    return this.#node;
  }

  /** The folder whose threads the list holds besides Current's, or null. */
  get folderId(): string | null {
    return this.#node.kind === "folder" ? this.#node.id : null;
  }

  get currentOpen(): boolean {
    return this.#currentOpen;
  }

  get openFolders(): ReadonlySet<string> {
    return this.#open;
  }

  choose(node: PanelNode): void {
    if (nodeKey(node) === nodeKey(this.#node)) return;
    const folderBefore = this.folderId;
    this.#node = node;
    // Archived lives inside Current: choosing it shows it.
    if (node.kind === "archived") this.#currentOpen = true;
    this.#changed();
    if (this.folderId !== folderBefore) for (const listener of this.#folderListeners) listener();
  }

  setCurrentOpen(open: boolean): void {
    if (open === this.#currentOpen) return;
    this.#currentOpen = open;
    // Folding Current with Archived chosen moves the choice to Current.
    if (!open && this.#node.kind === "archived") this.#node = CURRENT;
    this.#changed();
  }

  setFolderOpen(id: string, open: boolean): void {
    if (this.#open.has(id) === open) return;
    const next = new Set(this.#open);
    if (open) next.add(id);
    else next.delete(id);
    this.#open = next;
    this.#changed();
  }

  /** Whether a group of the chosen node was opened or closed against its default. */
  flipped(groupKey: string): boolean {
    return this.#flipped.has(`${nodeKey(this.#node)}|${groupKey}`);
  }

  flip(groupKey: string): void {
    const key = `${nodeKey(this.#node)}|${groupKey}`;
    const next = new Set(this.#flipped);
    if (!next.delete(key)) next.add(key);
    this.#flipped = next;
    this.#changed();
  }
}
