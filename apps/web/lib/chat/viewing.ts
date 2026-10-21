/**
 * The workspace file the member is looking at (KOBE-463, spec FE7): the active file tab of the
 * artifact column. The composer shows it as a removable "Viewing <file>" chip and each message
 * sends it as `viewing: {path}`; the server adds a bounded copy to that run's context. Removing
 * the chip holds for that file until another one is viewed.
 */
import type { MessageViewing } from "@kobe/protocol";

type Listener = () => void;

export class ViewingStore {
  #path: string | undefined;
  #dismissed: string | undefined;
  #listeners: readonly Listener[] = [];

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  };

  #set(path: string | undefined, dismissed: string | undefined) {
    if (path === this.#path && dismissed === this.#dismissed) return;
    this.#path = path;
    this.#dismissed = dismissed;
    for (const l of this.#listeners) l();
  }

  /** The viewed file, unless its chip was removed. */
  current = (): string | undefined => (this.#path === this.#dismissed ? undefined : this.#path);

  /** A file tab came on screen. */
  show(path: string): void {
    this.#set(path, path === this.#dismissed ? this.#dismissed : undefined);
  }

  /** `path`'s tab left the screen (another tab, closed, column hidden). */
  hide(path: string): void {
    if (this.#path === path) this.#set(undefined, this.#dismissed);
  }

  /** `path`'s tab closed: opening it again shows its chip again. */
  closed(path: string): void {
    this.hide(path);
    if (this.#dismissed === path) this.#set(this.#path, undefined);
  }

  /** The member removed the chip. */
  dismiss(): void {
    if (this.#path !== undefined) this.#set(this.#path, this.#path);
  }

  /** The message body's `viewing`. */
  body(): MessageViewing | undefined {
    const path = this.current();
    return path === undefined ? undefined : { path };
  }
}
