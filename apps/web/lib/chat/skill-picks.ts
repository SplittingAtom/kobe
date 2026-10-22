/**
 * The skill picked from the composer's + menu per draft (KOBE-451): at most one per message, shown
 * as a removable chip and sent as the message's `skill`; the server checks it is one a run here
 * loads. Immutable snapshots, so `useSyncExternalStore` readers re-render only on a change.
 */
type Listener = () => void;

export class SkillPickStore {
  #byDraft: ReadonlyMap<string, string> = new Map();
  #listeners: readonly Listener[] = [];

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  };

  #replace(next: ReadonlyMap<string, string>) {
    this.#byDraft = next;
    for (const l of this.#listeners) l();
  }

  /** The draft's picked skill, if any. */
  get(draft: string): string | undefined {
    return this.#byDraft.get(draft);
  }

  set(draft: string, skill: string): void {
    if (this.#byDraft.get(draft) === skill) return;
    this.#replace(new Map(this.#byDraft).set(draft, skill));
  }

  /** After a send (KOBE-415): drops the pick that went; one picked meanwhile stays. */
  clearSent(draft: string, sent: string | undefined): void {
    if (sent !== undefined && this.#byDraft.get(draft) === sent) this.clear(draft);
  }

  clear(draft: string): void {
    if (!this.#byDraft.has(draft)) return;
    const next = new Map(this.#byDraft);
    next.delete(draft);
    this.#replace(next);
  }

  /** The pick follows a draft that became a thread whose first message did not go (KOBE-194). */
  move(from: string, to: string): void {
    const skill = this.#byDraft.get(from);
    if (skill === undefined) return;
    const next = new Map(this.#byDraft);
    next.delete(from);
    next.set(to, skill);
    this.#replace(next);
  }
}
