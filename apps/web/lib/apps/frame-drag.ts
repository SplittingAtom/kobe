import type { BridgeDragEvent } from "./host-bridge";

/**
 * The live pointer drag out of an MCP App frame (KOBE-553, DRAG-CONTRACT.md "Host behaviour"),
 * one per session: the app's item (not trusted; the composer validates it on drop), the app's
 * title as `from`, and the pointer in page coordinates (the viewport's CSS pixels, as
 * `getBoundingClientRect` gives them). The ghost chip and the composer on screen subscribe.
 */
export interface FrameDrag {
  readonly item: Readonly<Record<string, unknown>>;
  readonly from: string;
  readonly x: number;
  readonly y: number;
}

export interface FrameDragEvent {
  readonly phase: "start" | "move" | "end" | "cancel";
  /** The drag as of this phase (for an end, at the release point). */
  readonly drag: FrameDrag;
}

/** One drag's controls; spent once it ended, was cancelled or was replaced by another start. */
export interface FrameDragHandle {
  move(x: number, y: number): void;
  end(x: number, y: number): void;
  cancel(): void;
}

type Listener = (event: FrameDragEvent) => void;

export class FrameDragStore {
  #live: FrameDrag | null = null;
  #token: object | null = null;
  #listeners: readonly Listener[] = [];

  /** The live drag, or null (a stable snapshot for `useSyncExternalStore`). */
  current = (): FrameDrag | null => this.#live;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners = [...this.#listeners, listener];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  };

  #emit(phase: FrameDragEvent["phase"], drag: FrameDrag) {
    for (const l of this.#listeners) l({ phase, drag });
  }

  /** Starts a drag at the page point; a live one is cancelled first. */
  start(item: Readonly<Record<string, unknown>>, from: string, x: number, y: number) {
    this.cancel();
    const token = {};
    this.#token = token;
    this.#live = { item, from, x, y };
    this.#emit("start", this.#live);
    const live = () => (this.#token === token ? this.#live : null);
    const handle: FrameDragHandle = {
      move: (mx, my) => {
        const drag = live();
        if (drag === null) return;
        this.#live = { ...drag, x: mx, y: my };
        this.#emit("move", this.#live);
      },
      end: (ex, ey) => {
        const drag = live();
        if (drag === null) return;
        this.#clear();
        this.#emit("end", { ...drag, x: ex, y: ey });
      },
      cancel: () => {
        if (live() !== null) this.cancel();
      },
    };
    return handle;
  }

  /** Cancels whatever drag is live (a press or Escape in the page, a replacing start). */
  cancel = (): void => {
    const drag = this.#live;
    if (drag === null) return;
    this.#clear();
    this.#emit("cancel", drag);
  };

  #clear() {
    this.#live = null;
    this.#token = null;
  }
}

/**
 * One frame's drag notifications (already in page coordinates) into the store, with the app's
 * title as `from`; `from` null (no composer for the frame) starts nothing. Each frame keeps its
 * own handle, so its late moves never move a drag another frame started since.
 */
export function frameDragRelay(store: FrameDragStore) {
  let live: FrameDragHandle | null = null;
  return (event: BridgeDragEvent, from: string | null): void => {
    switch (event.phase) {
      case "start":
        live?.cancel();
        live = from === null ? null : store.start(event.item, from, event.x, event.y);
        return;
      case "move":
        live?.move(event.x, event.y);
        return;
      case "end":
        live?.end(event.x, event.y);
        live = null;
        return;
      case "cancel":
        live?.cancel();
        live = null;
    }
  };
}

/** A frame-relative point on the page: the frame's offset plus the point (ac-2). */
export function pagePoint(
  frame: { readonly left: number; readonly top: number },
  x: number,
  y: number,
): { x: number; y: number } {
  return { x: frame.left + x, y: frame.top + y };
}

export function pointInRect(
  rect: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  },
  x: number,
  y: number,
): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
