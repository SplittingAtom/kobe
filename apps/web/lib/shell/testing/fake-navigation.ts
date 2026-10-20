import type { NavigationLike } from "../panel-history";

interface Entry {
  key: string;
  readonly index: number;
  url: string;
}

/**
 * A stand-in for the browser's Navigation API (happy-dom has none): a list of entries with keys,
 * moved by `push`, `replace` and `go`. `attach()` keeps it in step with `window.history`, so code
 * that calls `history.pushState`, `replaceState`, `back` or `go` moves it too.
 */
export class FakeNavigation implements NavigationLike {
  private list: Entry[];
  index = 0;
  private n = 0;
  private readonly listeners = new Set<() => void>();

  constructor(url: string) {
    this.list = [{ key: this.nextKey(), index: 0, url }];
  }

  private nextKey(): string {
    this.n += 1;
    return `k${this.n}`;
  }

  get currentEntry(): Entry | null {
    return this.list[this.index] ?? null;
  }

  get url(): string {
    return this.currentEntry?.url ?? "";
  }

  entries(): readonly Entry[] {
    return this.list;
  }

  addEventListener(_type: "currententrychange", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "currententrychange", listener: () => void): void {
    this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of [...this.listeners]) l();
  }

  push(url: string): void {
    this.list = [
      ...this.list.slice(0, this.index + 1),
      { key: this.nextKey(), index: this.index + 1, url },
    ];
    this.index += 1;
    this.changed();
  }

  replace(url: string): void {
    const at = this.list[this.index];
    if (at) at.url = url;
    this.changed();
  }

  go(delta: number): void {
    const to = this.index + delta;
    if (to < 0 || to >= this.list.length) return;
    this.index = to;
    this.changed();
  }

  /** Test-only: another branch of history took this entry's place. */
  replaceEntryKey(index: number, key: string): void {
    const at = this.list[index];
    if (at) at.key = key;
  }

  /** Mirrors `window.history` from now on; returns the undo. */
  attach(): () => void {
    const h = window.history;
    const original = {
      pushState: h.pushState.bind(h),
      replaceState: h.replaceState.bind(h),
      go: h.go.bind(h),
      back: h.back.bind(h),
      forward: h.forward.bind(h),
    };
    const path = (url: string | URL | null | undefined) => {
      const u = new URL(String(url ?? window.location.href), window.location.href);
      return `${u.pathname}${u.search}`;
    };
    h.pushState = (data, unused, url) => {
      original.pushState(data, unused, url);
      this.push(path(url));
    };
    h.replaceState = (data, unused, url) => {
      original.replaceState(data, unused, url);
      this.replace(path(url));
    };
    h.go = (delta?: number) => {
      this.go(delta ?? 0);
      original.go(delta);
    };
    h.back = () => h.go(-1);
    h.forward = () => h.go(1);
    return () => Object.assign(h, original);
  }
}
