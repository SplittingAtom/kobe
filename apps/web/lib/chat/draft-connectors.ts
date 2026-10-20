/**
 * Connectors turned off in the composer's + menu before the first message (KOBE-451 review
 * MEDIUM-3): sent with the thread's creation (`connectors_off`), where the server checks them like
 * the per-thread toggle. Once the thread exists its off set lives on the server. Immutable
 * snapshots for `useSyncExternalStore`.
 */
type Listener = () => void;
const NONE: ReadonlySet<string> = new Set();

export class DraftConnectorStore {
  #off: ReadonlySet<string> = NONE;
  #listeners: readonly Listener[] = [];

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  };

  #replace(next: ReadonlySet<string>) {
    this.#off = next;
    for (const l of this.#listeners) l();
  }

  /** The connectors off for the next new conversation. */
  snapshot = (): ReadonlySet<string> => this.#off;

  set(connectorId: string, enabled: boolean): void {
    if (this.#off.has(connectorId) === !enabled) return;
    const next = new Set(this.#off);
    if (enabled) next.delete(connectorId);
    else next.add(connectorId);
    this.#replace(next);
  }

  /** Taken by the thread's creation: the next new conversation starts with everything on. */
  take(): readonly string[] {
    const ids = [...this.#off];
    if (ids.length > 0) this.#replace(NONE);
    return ids;
  }
}
